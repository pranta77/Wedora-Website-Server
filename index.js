import cors from "cors";
import express from "express";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";

import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";

const app = express();
const PORT = process.env.PORT || 5000;

// CORS
app.use(
  cors({
    origin: "http://localhost:3000",
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

    trustedOrigins: ["http://localhost:3000"],

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
  });

  // Better Auth route (must come before express.json)
  app.all("/api/auth/{*any}", toNodeHandler(auth));

  // Middleware for other API routes
  app.use(express.json());
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
      }
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
  app.post("/services", verifyUser, verifyVendor, async (req, res) => {
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
      { _id: req.user.id },
      {
        projection: {
          name: 1,
          email: 1,
          image: 1,
          role: 1,
          phone: 1,
          location: 1,
          bio: 1,
        },
      }
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
      { _id: req.user.id },
      {
        $set: {
          name: name.trim(),
          image: image?.trim() || "",
          phone: phone?.trim() || "",
          location: location?.trim() || "",
          bio: bio?.trim() || "",
          updatedAt: new Date(),
        },
      }
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
app.patch("/vendor/services/:id", verifyUser, verifyVendor, async (req, res) => {
  try {
    const { id } = req.params;
    const { serviceName, category, description, price, location, images } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        success: false,
        message: "Invalid service ID.",
      });
    }

    if (!serviceName || !category || !description || !price || !location || !images) {
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
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({
        success: false,
        message: "Service not found.",
      });
    }

    res.status(200).send({
      success: true,
      message: "Service updated successfully! It is pending admin approval.",
    });
  } catch (error) {
    console.error("Failed to update service:", error);

    res.status(500).send({
      success: false,
      message: "Failed to update service.",
    });
  }
});
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
        }
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
  }
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
  }
);

  // Get all approved and active services
  app.get("/services", async (req, res) => {
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

  // Start server
  app.listen(PORT, () => {
    console.log("Wedora server listening on port " + PORT);
  });
} catch (error) {
  console.error("MongoDB connection failed:", error);
  process.exit(1);
}

export default app;
