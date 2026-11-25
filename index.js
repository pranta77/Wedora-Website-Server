import cors from "cors";
import express from "express";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";

import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import Stripe from "stripe";
import { jwt } from "better-auth/plugins";
import { jwtVerify, createRemoteJWKSet } from "jose";

const app = express();
app.set("trust proxy", 1);

const PORT = process.env.PORT || 5000;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const isProduction =
  process.env.NODE_ENV === "production" ||
  process.env.BETTER_AUTH_URL?.startsWith("https://") ||
  Boolean(process.env.VERCEL) ||
  Boolean(process.env.RENDER);

const CLIENT_URL =
  process.env.CLIENT_URL ||
  (isProduction ? "https://wedora-client.vercel.app" : "http://localhost:3000");

const allowedOrigins = [
  "http://localhost:3000",
  "https://wedora-client.vercel.app",
  ...(process.env.CLIENT_URL ? [process.env.CLIENT_URL] : []),
];

// CORS
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  }),
);

// MongoDB connection
const client = new MongoClient(process.env.MONGODB_URI);

try {
  await client.connect();
  console.log("Successfully connected to MongoDB!");

  const db = client.db("Wedora-DB");

  // Business collections
  const usersCollection = db.collection("users");
  const servicesCollection = db.collection("services");
  const bookingsCollection = db.collection("bookings");
  const transactionsCollection = db.collection("transactions");

  // Better Auth configuration
  const auth = betterAuth({
    database: mongodbAdapter(db),

    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL,

    trustedOrigins: allowedOrigins,

    advanced: {
      useSecureCookies: isProduction,
      defaultCookieAttributes: {
        sameSite: isProduction ? "none" : "lax",
        secure: isProduction,
        httpOnly: true,
        partitioned: isProduction,
      },
    },

    user: {
      modelName: "users",

      additionalFields: {
        role: {
          type: "string",
          required: true,
          defaultValue: "customer",
          input: true,
        },

        isBlocked: {
          type: "boolean",
          defaultValue: false,
          input: false,
        },

        businessName: {
          type: "string",
          required: false,
          input: false,
        },

        subscriptionPlan: {
          type: "string",
          defaultValue: "free",
          input: false,
        },

        subscriptionExpiresAt: {
          type: "date",
          required: false,
          input: false,
        },
      },
    },

    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            return {
              data: {
                ...user,
                role: user.role === "vendor" ? "vendor" : "customer",
              },
            };
          },
        },
      },
    },

    emailAndPassword: {
      enabled: true,
      minPasswordLength: 6,
    },

    socialProviders: {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      },
    },
    plugins:[jwt()]
  });

  // Better Auth route (must come before express.json)
  app.all("/api/auth/{*any}", toNodeHandler(auth));

  // Stripe Webhook (must come before express.json)
  app.post(
    "/webhook",
    express.raw({ type: "application/json" }),
    async (req, res) => {
      const signature = req.headers["stripe-signature"];

      let event;

      // Verify Stripe webhook signature
      try {
        event = stripe.webhooks.constructEvent(
          req.body,
          signature,
          process.env.STRIPE_WEBHOOK_SECRET,
        );
      } catch (error) {
        console.error("Webhook signature error:", error.message);

        return res.status(400).send({
          success: false,
          message: "Invalid webhook signature.",
        });
      }

      try {
        // Successful subscription checkout
        if (event.type === "checkout.session.completed") {
          const session = event.data.object;

          if (session.mode !== "subscription") {
            return res.status(200).send({ received: true });
          }

          const vendorId = session.metadata?.vendorId;

          if (!ObjectId.isValid(vendorId)) {
            return res.status(400).send({
              success: false,
              message: "Invalid vendor ID.",
            });
          }

          // Prevent duplicate transaction records
          const existingTransaction = await transactionsCollection.findOne({
            stripeSessionId: session.id,
          });

          if (!existingTransaction) {
            const subscription = await stripe.subscriptions.retrieve(
              session.subscription,
            );

            if (!["active", "trialing"].includes(subscription.status)) {
              return res.status(200).send({
                received: true,
                activated: false,
              });
            }

            const vendor = await usersCollection.findOne({
              _id: new ObjectId(vendorId),
              role: "vendor",
            });

            if (!vendor) {
              return res.status(404).send({
                success: false,
                message: "Vendor not found.",
              });
            }

            const periodEnd =
              subscription.items?.data?.[0]?.current_period_end ||
              subscription.current_period_end;

            const updateData = {
              subscriptionPlan: "premium",
              subscriptionStatus: subscription.status,
              stripeCustomerId: session.customer,
              stripeSubscriptionId: session.subscription,
              subscriptionUpdatedAt: new Date(),
            };

            if (periodEnd) {
              updateData.subscriptionExpiresAt = new Date(periodEnd * 1000);
            }

            await usersCollection.updateOne(
              { _id: new ObjectId(vendorId) },
              { $set: updateData },
            );

            // Save transaction
            await transactionsCollection.insertOne({
              vendorId,
              vendorName: vendor.name,
              vendorEmail: vendor.email,
              plan: "premium",
              stripeSessionId: session.id,
              stripeSubscriptionId: session.subscription,
              amount: session.amount_total,
              currency: session.currency,
              status: "completed",
              createdAt: new Date(),
            });

            console.log("Premium subscription activated:", vendor.email);
          }
        }

        // Subscription updated (including scheduled cancellation)
        if (event.type === "customer.subscription.updated") {
          const subscription = event.data.object;
          const vendorId = subscription.metadata?.vendorId;

          if (ObjectId.isValid(vendorId)) {
            const periodEnd =
              subscription.items?.data?.[0]?.current_period_end ||
              subscription.current_period_end;

            const updateData = {
              subscriptionStatus: subscription.status,
              subscriptionUpdatedAt: new Date(),
              subscriptionCancelAtPeriodEnd: subscription.cancel_at_period_end,
            };

            if (periodEnd) {
              updateData.subscriptionExpiresAt = new Date(periodEnd * 1000);
            }

            await usersCollection.updateOne(
              {
                _id: new ObjectId(vendorId),
                stripeSubscriptionId: subscription.id,
              },
              {
                $set: updateData,
              },
            );

            console.log("Subscription updated:", vendorId, subscription.status);
          }
        }

        // Subscription actually expired or cancelled
        if (event.type === "customer.subscription.deleted") {
          const subscription = event.data.object;
          const vendorId = subscription.metadata?.vendorId;

          if (ObjectId.isValid(vendorId)) {
            await usersCollection.updateOne(
              {
                _id: new ObjectId(vendorId),
                stripeSubscriptionId: subscription.id,
              },
              {
                $set: {
                  subscriptionPlan: "basic",
                  subscriptionStatus: "canceled",
                  subscriptionCancelAtPeriodEnd: false,
                  subscriptionUpdatedAt: new Date(),
                },
                $unset: {
                  subscriptionExpiresAt: "",
                  stripeSubscriptionId: "",
                },
              },
            );

            console.log("Vendor downgraded to Basic:", vendorId);
          }
        }

        return res.status(200).send({ received: true });
      } catch (error) {
        console.error("Webhook processing error:", error);

        return res.status(500).send({
          success: false,
          message: "Webhook processing failed.",
        });
      }
    },
  );

  // Middleware for other API routes
  app.use(express.json());



// Better Auth public JWT verification keys
const JWKS = createRemoteJWKSet(
  new URL("/api/auth/jwks", process.env.BETTER_AUTH_URL)
);

// Verify JWT token
const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).send({
      success: false,
      message: "Unauthorized!",
    });
  }

  const token = authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).send({
      success: false,
      message: "Unauthorized!",
    });
  }

  let payload;

  try {
    const result = await jwtVerify(token, JWKS, {
      issuer: process.env.BETTER_AUTH_URL,
      audience: process.env.BETTER_AUTH_URL,
    });

    payload = result.payload;
  } catch (error) {
    return res.status(401).send({
      success: false,
      message: "Invalid or expired token!",
    });
  }

  if (!payload.sub || !ObjectId.isValid(payload.sub)) {
    return res.status(401).send({
      success: false,
      message: "Invalid user token!",
    });
  }

  try {
    // Get trusted user information from MongoDB
    const user = await usersCollection.findOne({
      _id: new ObjectId(payload.sub),
    });

    if (!user) {
      return res.status(401).send({
        success: false,
        message: "User not found!",
      });
    }

    if (user.isBlocked) {
      return res.status(403).send({
        success: false,
        message: "Your account has been blocked.",
      });
    }

    req.user = {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      role: user.role,
    };

    next();
  } catch (error) {
    console.error("JWT authentication error:", error);

    return res.status(500).send({
      success: false,
      message: "Authentication service error.",
    });
  }
};



  // Verify logged-in user
  const verifyUser = async (req, res, next) => {
    try {
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(req.headers),
      });

      if (!session?.user) {
        return res.status(401).send({
          success: false,
          message: "Please log in first.",
        });
      }

      if (session.user.isBlocked) {
        return res.status(403).send({
          success: false,
          message: "Your account has been blocked.",
        });
      }

      req.user = session.user;
      next();
    } catch (error) {
      console.error("Authentication failed:", error);

      res.status(401).send({
        success: false,
        message: "Authentication failed.",
      });
    }
  };

  // Allow vendors only
  const verifyVendor = (req, res, next) => {
    if (req.user.role !== "vendor") {
      return res.status(403).send({
        success: false,
        message: "Only vendors can perform this action.",
      });
    }

    next();
  };

  // Allow admins only
  const verifyAdmin = (req, res, next) => {
    if (req.user.role !== "admin") {
      return res.status(403).send({
        success: false,
        message: "Only admins can perform this action.",
      });
    }

    next();
  };

  // Create Booking (Customer Only)
  app.post("/bookings", verifyUser, async (req, res) => {
    try {
      const { serviceId, eventDate, eventLocation, message } = req.body;

      if (req.user.role !== "customer") {
        return res.status(403).send({
          success: false,
          message: "Only customers can book services.",
        });
      }

      if (!ObjectId.isValid(serviceId)) {
        return res.status(400).send({
          success: false,
          message: "Invalid service ID.",
        });
      }

      if (!eventDate || !eventLocation?.trim()) {
        return res.status(400).send({
          success: false,
          message: "Event date and location are required.",
        });
      }

      const datePattern = /^\d{4}-\d{2}-\d{2}$/;

      if (!datePattern.test(eventDate)) {
        return res.status(400).send({
          success: false,
          message: "Invalid event date.",
        });
      }

      const selectedDate = new Date(`${eventDate}T00:00:00.000Z`);

      if (
        Number.isNaN(selectedDate.getTime()) ||
        selectedDate.toISOString().slice(0, 10) !== eventDate
      ) {
        return res.status(400).send({
          success: false,
          message: "Invalid event date.",
        });
      }

      const today = new Date().toLocaleDateString("en-CA", {
        timeZone: "Asia/Dhaka",
      });

      if (eventDate < today) {
        return res.status(400).send({
          success: false,
          message: "Event date cannot be in the past.",
        });
      }

      const service = await servicesCollection.findOne({
        _id: new ObjectId(serviceId),
        status: "approved",
        isActive: true,
      });

      if (!service) {
        return res.status(404).send({
          success: false,
          message: "This service is currently unavailable.",
        });
      }

      if (service.vendorId === req.user.id) {
        return res.status(400).send({
          success: false,
          message: "You cannot book your own service.",
        });
      }

      const newBooking = {
        serviceId: service._id,
        serviceName: service.serviceName,
        vendorId: service.vendorId,
        vendorName: service.vendorName,
        customerId: req.user.id,
        customerName: req.user.name,
        customerEmail: req.user.email,
        eventDate,
        eventLocation: eventLocation.trim(),
        message: message?.trim() || "",
        price: Number(service.price),
        status: "pending",
        createdAt: new Date(),
      };

      const result = await bookingsCollection.insertOne(newBooking);

      res.status(201).send({
        success: true,
        message: "Booking request submitted successfully!",
        bookingId: result.insertedId,
      });
    } catch (error) {
      console.error("Failed to create booking:", error);

      res.status(500).send({
        success: false,
        message: "Failed to submit booking request.",
      });
    }
  });

  // Get Customer Bookings
  app.get("/customer/bookings", verifyUser, async (req, res) => {
    try {
      if (req.user.role !== "customer") {
        return res.status(403).send({
          success: false,
          message: "Only customers can view their bookings.",
        });
      }

      const bookings = await bookingsCollection
        .find({ customerId: req.user.id })
        .sort({ createdAt: -1 })
        .toArray();

      res.status(200).send({
        success: true,
        bookings,
      });
    } catch (error) {
      console.error("Failed to fetch customer bookings:", error);

      res.status(500).send({
        success: false,
        message: "Failed to fetch bookings.",
      });
    }
  });

  // Cancel Customer Booking
  app.patch("/customer/bookings/:id/cancel", verifyUser, async (req, res) => {
    try {
      if (req.user.role !== "customer") {
        return res.status(403).send({
          success: false,
          message: "Only customers can cancel bookings.",
        });
      }

      const { id } = req.params;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({
          success: false,
          message: "Invalid booking ID.",
        });
      }

      const result = await bookingsCollection.updateOne(
        {
          _id: new ObjectId(id),
          customerId: req.user.id,
          status: "pending",
        },
        {
          $set: {
            status: "cancelled",
            updatedAt: new Date(),
          },
        },
      );

      if (result.matchedCount === 0) {
        return res.status(404).send({
          success: false,
          message: "Pending booking not found or already processed.",
        });
      }

      res.status(200).send({
        success: true,
        message: "Booking cancelled successfully!",
      });
    } catch (error) {
      console.error("Failed to cancel booking:", error);

      res.status(500).send({
        success: false,
        message: "Failed to cancel booking.",
      });
    }
  });

  // Get featured services
  app.get("/services/featured", async (req, res) => {
    try {
      const services = await servicesCollection
        .find({
          status: "approved",
          isActive: true,
        })
        .sort({ createdAt: -1 })
        .limit(6)
        .toArray();

      res.status(200).send({
        success: true,
        services,
      });
    } catch (error) {
      console.error("Failed to fetch featured services:", error);

      res.status(500).send({
        success: false,
        message: "Failed to fetch featured services",
      });
    }
  });


  // Add a new wedding service  
  app.post("/services", /* verifyUser */ verifyToken, verifyVendor, async (req, res) => {
    console.log("header on ther ",req.headers);
    
    try {
      const { serviceName, category, description, price, location, images } =
        req.body;

      if (
        !serviceName ||
        !category ||
        !description ||
        !price ||
        !location ||
        !images
      ) {
        return res.status(400).send({
          success: false,
          message: "Please provide all required fields.",
        });
      }

      if (Number(price) <= 0 || !Number.isFinite(Number(price))) {
        return res.status(400).send({
          success: false,
          message: "Please provide a valid price.",
        });
      }

      // Get vendor subscription information
      const vendor = await usersCollection.findOne({
        _id: new ObjectId(req.user.id),
        role: "vendor",
      });

      if (!vendor) {
        return res.status(404).send({
          success: false,
          message: "Vendor not found.",
        });
      }

      // Check whether Premium subscription is valid
      const isPremium =
        vendor.subscriptionPlan === "premium" &&
        ["active", "trialing"].includes(vendor.subscriptionStatus) &&
        vendor.subscriptionExpiresAt &&
        new Date(vendor.subscriptionExpiresAt) > new Date();

      // Check Basic plan service limit
      if (!isPremium) {
        const activeServices = await servicesCollection.countDocuments({
          vendorId: req.user.id,
          status: "approved",
          isActive: true,
        });

        if (activeServices >= 3) {
          return res.status(403).send({
            success: false,
            message:
              "Basic plan allows only 3 active services. Upgrade to Premium for unlimited services.",
          });
        }
      }

      // Create new service
      const newService = {
        vendorId: req.user.id,
        vendorName: req.user.name,
        serviceName,
        category,
        description,
        price: Number(price),
        location,
        images: [images],
        status: "pending",
        isActive: true,
        createdAt: new Date(),
      };

      const result = await servicesCollection.insertOne(newService);

      res.status(201).send({
        success: true,
        message: "Service submitted for admin approval!",
        insertedId: result.insertedId,
      });
    } catch (error) {
      console.error("Failed to add service:", error);

      res.status(500).send({
        success: false,
        message: "Failed to add service.",
      });
    }
  });

  // Get services belonging to the logged-in vendor
  app.get("/vendor/services", verifyUser, verifyVendor, async (req, res) => {
    try {
      const services = await servicesCollection
        .find({ vendorId: req.user.id })
        .sort({ createdAt: -1 })
        .toArray();

      res.status(200).send({
        success: true,
        services,
      });
    } catch (error) {
      console.error("Failed to fetch vendor services:", error);

      res.status(500).send({
        success: false,
        message: "Failed to fetch your services.",
      });
    }
  });

  // Get Vendor Profile
  app.get("/vendor/profile", verifyUser, verifyVendor, async (req, res) => {
    try {
      const vendor = await usersCollection.findOne(
        { _id: new ObjectId(req.user.id) },
        {
          projection: {
            name: 1,
            email: 1,
            image: 1,
            role: 1,
            phone: 1,
            location: 1,
            bio: 1,
            subscriptionPlan: 1,
            subscriptionStatus: 1,
            subscriptionExpiresAt: 1,
          },
        },
      );

      if (!vendor) {
        return res.status(404).send({
          success: false,
          message: "Vendor profile not found.",
        });
      }

      res.status(200).send({
        success: true,
        vendor,
      });
    } catch (error) {
      console.error("Failed to load vendor profile:", error);

      res.status(500).send({
        success: false,
        message: "Failed to load vendor profile.",
      });
    }
  });

  // Get Available Subscription Plans
  app.get("/subscription-plans", async (req, res) => {
    try {
      const plans = [
        {
          id: "basic",
          name: "Basic",
          price: 0,
          duration: "Free forever",
          features: [
            "Add up to 3 active wedding services",
            "Manage booking requests",
            "Basic vendor profile",
          ],
        },
        {
          id: "premium",
          name: "Premium",
          price: 1999,
          duration: "Per month",
          features: [
            "Unlimited wedding services",
            "Manage booking requests",
            "Featured vendor profile",
            "Priority support",
            "Premium visibility",
          ],
        },
      ];

      res.status(200).send({
        success: true,
        plans,
      });
    } catch (error) {
      console.error("Failed to fetch subscription plans:", error);

      res.status(500).send({
        success: false,
        message: "Failed to load subscription plans.",
      });
    }
  });

  // Create Premium Subscription Checkout
  app.post(
    "/create-checkout-session",
    verifyUser,
    verifyVendor,
    async (req, res) => {
      try {
        if (!process.env.STRIPE_PREMIUM_PRICE_ID) {
          return res.status(500).send({
            success: false,
            message: "Premium price ID is missing.",
          });
        }

        const session = await stripe.checkout.sessions.create({
          mode: "subscription",
          customer_email: req.user.email,
          client_reference_id: req.user.id,

          metadata: {
            vendorId: req.user.id,
            plan: "premium",
          },

          subscription_data: {
            metadata: {
              vendorId: req.user.id,
              plan: "premium",
            },
          },

          line_items: [
            {
              price: process.env.STRIPE_PREMIUM_PRICE_ID,
              quantity: 1,
            },
          ],

          success_url: `${CLIENT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${CLIENT_URL}/payment/cancel`,
        });

        res.status(200).send({
          success: true,
          url: session.url,
        });
      } catch (error) {
        console.error("Stripe checkout error:", error);

        res.status(500).send({
          success: false,
          message: "Unable to create checkout session.",
        });
      }
    },
  );

  app.post(
    "/cancel-subscription",
    verifyUser,
    verifyVendor,
    async (req, res) => {
      try {
        const vendorId = req.user.id;

        if (!ObjectId.isValid(vendorId)) {
          return res.status(400).send({
            success: false,
            message: "Invalid vendor ID.",
          });
        }

        // Find vendor
        const vendor = await usersCollection.findOne({
          _id: new ObjectId(vendorId),
          role: "vendor",
        });

        if (!vendor || !vendor.stripeSubscriptionId) {
          return res.status(404).send({
            success: false,
            message: "No active subscription found.",
          });
        }

        // Retrieve Stripe subscription
        const subscription = await stripe.subscriptions.retrieve(
          vendor.stripeSubscriptionId,
        );

        // Verify subscription ownership
        if (subscription.metadata?.vendorId !== vendorId) {
          return res.status(403).send({
            success: false,
            message: "Subscription ownership verification failed.",
          });
        }

        if (!["active", "trialing"].includes(subscription.status)) {
          return res.status(400).send({
            success: false,
            message: "Subscription is not active.",
          });
        }

        if (subscription.cancel_at_period_end) {
          return res.status(200).send({
            success: true,
            message: "Cancellation is already scheduled.",
          });
        }

        // Schedule cancellation at billing period end
        const updatedSubscription = await stripe.subscriptions.update(
          subscription.id,
          {
            cancel_at_period_end: true,
          },
        );

        const periodEnd =
          updatedSubscription.items?.data?.[0]?.current_period_end ||
          updatedSubscription.current_period_end;

        await usersCollection.updateOne(
          {
            _id: new ObjectId(vendorId),
            stripeSubscriptionId: subscription.id,
          },
          {
            $set: {
              subscriptionCancelAtPeriodEnd: true,
              subscriptionExpiresAt: periodEnd
                ? new Date(periodEnd * 1000)
                : vendor.subscriptionExpiresAt,
              subscriptionUpdatedAt: new Date(),
            },
          },
        );

        return res.status(200).send({
          success: true,
          message: "Subscription cancellation scheduled successfully.",
          expiresAt: periodEnd ? new Date(periodEnd * 1000) : null,
        });
      } catch (error) {
        console.error("Subscription cancellation error:", error);

        return res.status(500).send({
          success: false,
          message: "Unable to cancel subscription.",
        });
      }
    },
  );

  // Update Vendor Profile
  app.patch("/vendor/profile", verifyUser, verifyVendor, async (req, res) => {
    try {
      const { name, image, phone, location, bio } = req.body;

      if (!name?.trim()) {
        return res.status(400).send({
          success: false,
          message: "Name is required.",
        });
      }

      const result = await usersCollection.updateOne(
        { _id: new ObjectId(req.user.id) },
        {
          $set: {
            name: name.trim(),
            image: image?.trim() || "",
            phone: phone?.trim() || "",
            location: location?.trim() || "",
            bio: bio?.trim() || "",
            updatedAt: new Date(),
          },
        },
      );

      if (result.matchedCount === 0) {
        return res.status(404).send({
          success: false,
          message: "Vendor not found.",
        });
      }

      res.status(200).send({
        success: true,
        message: "Profile updated successfully!",
      });
    } catch (error) {
      console.error("Failed to update vendor profile:", error);

      res.status(500).send({
        success: false,
        message: "Failed to update profile.",
      });
    }
  });

  // Update Vendor Service
  app.patch(
    "/vendor/services/:id",
   /*  verifyUser, */
   verifyToken,
    verifyVendor,
    async (req, res) => {
      try {
        const { id } = req.params;
        const { serviceName, category, description, price, location, images } =
          req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({
            success: false,
            message: "Invalid service ID.",
          });
        }

        if (
          !serviceName ||
          !category ||
          !description ||
          !price ||
          !location ||
          !images
        ) {
          return res.status(400).send({
            success: false,
            message: "Please provide all required fields.",
          });
        }

        const result = await servicesCollection.updateOne(
          {
            _id: new ObjectId(id),
            vendorId: req.user.id,
          },
          {
            $set: {
              serviceName,
              category,
              description,
              price: Number(price),
              location,
              images: [images],
              status: "pending",
              updatedAt: new Date(),
            },
          },
        );

        if (result.matchedCount === 0) {
          return res.status(404).send({
            success: false,
            message: "Service not found.",
          });
        }

        res.status(200).send({
          success: true,
          message:
            "Service updated successfully! It is pending admin approval.",
        });
      } catch (error) {
        console.error("Failed to update service:", error);

        res.status(500).send({
          success: false,
          message: "Failed to update service.",
        });
      }
    },
  );

  // Get Vendor Bookings
  app.get("/vendor/bookings", verifyUser, verifyVendor, async (req, res) => {
    try {
      const bookings = await bookingsCollection
        .find({ vendorId: req.user.id })
        .sort({ createdAt: -1 })
        .toArray();

      res.status(200).send({
        success: true,
        bookings,
      });
    } catch (error) {
      console.error("Failed to fetch vendor bookings:", error);

      res.status(500).send({
        success: false,
        message: "Failed to fetch bookings.",
      });
    }
  });

  // Update Vendor Booking Status
  app.patch(
    "/vendor/bookings/:id/status",
    verifyUser,
    verifyVendor,
    async (req, res) => {
      try {
        const { id } = req.params;
        const { status } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({
            success: false,
            message: "Invalid booking ID.",
          });
        }

        if (!["accepted", "rejected"].includes(status)) {
          return res.status(400).send({
            success: false,
            message: "Invalid booking status.",
          });
        }

        const result = await bookingsCollection.updateOne(
          {
            _id: new ObjectId(id),
            vendorId: req.user.id,
            status: "pending",
          },
          {
            $set: {
              status,
              updatedAt: new Date(),
            },
          },
        );

        if (result.matchedCount === 0) {
          return res.status(404).send({
            success: false,
            message: "Pending booking not found.",
          });
        }

        res.status(200).send({
          success: true,
          message: `Booking ${status} successfully!`,
        });
      } catch (error) {
        console.error("Failed to update booking:", error);

        res.status(500).send({
          success: false,
          message: "Failed to update booking status.",
        });
      }
    },
  );

  // Get all services for admin
  app.get("/admin/services", verifyUser, verifyAdmin, async (req, res) => {
    try {
      const services = await servicesCollection
        .find({})
        .sort({ createdAt: -1 })
        .toArray();

      res.status(200).send({
        success: true,
        services,
      });
    } catch (error) {
      console.error("Failed to fetch admin services:", error);

      res.status(500).send({
        success: false,
        message: "Failed to fetch services.",
      });
    }
  });

  // Get All Users (Admin Only)
  app.get("/admin/users", verifyUser, verifyAdmin, async (req, res) => {
    try {
      const users = await usersCollection
        .find(
          {},
          {
            projection: {
              name: 1,
              email: 1,
              image: 1,
              role: 1,
              isBlocked: 1,
              createdAt: 1,
            },
          },
        )
        .sort({ createdAt: -1 })
        .toArray();

      res.status(200).send({
        success: true,
        users,
      });
    } catch (error) {
      console.error("Failed to fetch users:", error);

      res.status(500).send({
        success: false,
        message: "Failed to load users.",
      });
    }
  });

  // Get All Platform Transactions
  app.get("/admin/transactions", verifyUser, verifyAdmin, async (req, res) => {
    try {
      const transactions = await transactionsCollection
        .find({})
        .sort({ createdAt: -1 })
        .toArray();

      res.status(200).send({
        success: true,
        transactions,
      });
    } catch (error) {
      console.error("Failed to fetch transactions:", error);

      res.status(500).send({
        success: false,
        message: "Failed to fetch transactions.",
      });
    }
  });

  // Block or Unblock User (Admin Only)
  app.patch(
    "/admin/users/:id/status",
    verifyUser,
    verifyAdmin,
    async (req, res) => {
      try {
        const { id } = req.params;
        const { isBlocked } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({
            success: false,
            message: "Invalid user ID.",
          });
        }

        if (typeof isBlocked !== "boolean") {
          return res.status(400).send({
            success: false,
            message: "Invalid account status.",
          });
        }

        const result = await usersCollection.updateOne(
          {
            _id: new ObjectId(id),
            role: { $in: ["customer", "vendor"] },
          },
          {
            $set: {
              isBlocked,
              updatedAt: new Date(),
            },
          },
        );

        if (result.matchedCount === 0) {
          return res.status(404).send({
            success: false,
            message: "Customer or vendor not found.",
          });
        }

        res.status(200).send({
          success: true,
          message: isBlocked
            ? "User blocked successfully."
            : "User unblocked successfully.",
        });
      } catch (error) {
        console.error("Failed to update user status:", error);

        res.status(500).send({
          success: false,
          message: "Failed to update user status.",
        });
      }
    },
  );

  // Approve or reject a service

  // Approve or reject a service (change)
  app.patch(
    "/admin/services/:id/status",
    verifyUser,
    verifyAdmin,
    async (req, res) => {
      try {
        const { id } = req.params;
        const { status } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({
            success: false,
            message: "Invalid service ID.",
          });
        }

        if (!["approved", "rejected"].includes(status)) {
          return res.status(400).send({
            success: false,
            message: "Invalid service status.",
          });
        }

        // Find pending service
        const service = await servicesCollection.findOne({
          _id: new ObjectId(id),
          status: "pending",
        });

        if (!service) {
          return res.status(404).send({
            success: false,
            message: "Pending service not found.",
          });
        }

        // Apply service limit only when approving
        if (status === "approved") {
          const vendor = await usersCollection.findOne({
            _id: new ObjectId(service.vendorId),
            role: "vendor",
          });

          if (!vendor) {
            return res.status(404).send({
              success: false,
              message: "Vendor not found.",
            });
          }

          // Check Premium subscription
          const isPremium =
            vendor.subscriptionPlan === "premium" &&
            ["active", "trialing"].includes(vendor.subscriptionStatus) &&
            vendor.subscriptionExpiresAt &&
            new Date(vendor.subscriptionExpiresAt) > new Date();

          // Check Basic plan limit
          if (!isPremium) {
            const activeServices = await servicesCollection.countDocuments({
              vendorId: service.vendorId,
              status: "approved",
              isActive: true,
            });

            if (activeServices >= 3) {
              return res.status(403).send({
                success: false,
                message:
                  "This vendor has reached the Basic plan limit of 3 active services.",
              });
            }
          }
        }

        // Update service status
        const result = await servicesCollection.updateOne(
          {
            _id: new ObjectId(id),
            status: "pending",
          },
          {
            $set: {
              status,
              updatedAt: new Date(),
            },
          },
        );

        if (result.matchedCount === 0) {
          return res.status(404).send({
            success: false,
            message: "Pending service not found.",
          });
        }

        res.status(200).send({
          success: true,
          message: `Service ${status} successfully.`,
        });
      } catch (error) {
        console.error("Failed to update service status:", error);

        res.status(500).send({
          success: false,
          message: "Failed to update service status.",
        });
      }
    },
  );

  // Delete a service (Admin only)
  app.delete(
    "/admin/services/:id",
    verifyUser,
    verifyAdmin,
    async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({
            success: false,
            message: "Invalid service ID.",
          });
        }

        const result = await servicesCollection.deleteOne({
          _id: new ObjectId(id),
        });

        if (result.deletedCount === 0) {
          return res.status(404).send({
            success: false,
            message: "Service not found.",
          });
        }

        res.status(200).send({
          success: true,
          message: "Service deleted successfully.",
        });
      } catch (error) {
        console.error("Failed to delete service:", error);

        res.status(500).send({
          success: false,
          message: "Failed to delete service.",
        });
      }
    },
  );

  // Delete Vendor Service
  app.delete(
    "/vendor/services/:id",
    verifyUser,
    verifyVendor,
    async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({
            success: false,
            message: "Invalid service ID.",
          });
        }

        const result = await servicesCollection.deleteOne({
          _id: new ObjectId(id),
          vendorId: req.user.id,
        });

        if (result.deletedCount === 0) {
          return res.status(404).send({
            success: false,
            message: "Service not found.",
          });
        }

        res.status(200).send({
          success: true,
          message: "Service deleted successfully.",
        });
      } catch (error) {
        console.error("Failed to delete vendor service:", error);

        res.status(500).send({
          success: false,
          message: "Failed to delete service.",
        });
      }
    },
  );

  // Get all approved and active services
  app.get("/services",  async (req, res) => {
    try {
      const services = await servicesCollection
        .find({
          status: "approved",
          isActive: true,
        })
        .sort({ createdAt: -1 })
        .toArray();

      res.status(200).send({
        success: true,
        services,
      });
    } catch (error) {
      console.error("Failed to fetch services:", error);

      res.status(500).send({
        success: false,
        message: "Failed to fetch services",
      });
    }
  });

  // Get Single Service Details
  app.get("/services/:id", async (req, res) => {
    try {
      const { id } = req.params;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({
          success: false,
          message: "Invalid service ID.",
        });
      }

      const service = await servicesCollection.findOne({
        _id: new ObjectId(id),
        status: "approved",
        isActive: true,
      });

      if (!service) {
        return res.status(404).send({
          success: false,
          message: "Service not found.",
        });
      }

      res.status(200).send({
        success: true,
        service,
      });
    } catch (error) {
      console.error("Failed to fetch service:", error);

      res.status(500).send({
        success: false,
        message: "Failed to fetch service details.",
      });
    }
  });

  // Root route
  app.get("/", (req, res) => {
    res.send("Hello Wedora Server");
  });

  // Start server (Vercel serverless e app.listen skip korbe)
  if (!process.env.VERCEL) {
    app.listen(PORT, () => {
      console.log("Wedora server listening on port " + PORT);
    });
  }
} catch (error) {
  console.error("MongoDB connection failed:", error);
  process.exit(1);
}

export default app;
