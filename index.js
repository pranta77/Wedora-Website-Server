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
  // app.post("/services", verifyUser, verifyVendor, async (req, res) => {
  //   try {
  //     const { serviceName, category, description, price, location, images } =
  //       req.body;

  //     if (
  //       !serviceName ||
  //       !category ||
  //       !description ||
  //       !price ||
  //       !location ||
  //       !images
  //     ) {
  //       return res.status(400).send({
  //         success: false,
  //         message: "Please provide all required fields.",
  //       });
  //     }

  //     if (Number(price) <= 0 || !Number.isFinite(Number(price))) {
  //       return res.status(400).send({
  //         success: false,
  //         message: "Please provide a valid price.",
  //       });
  //     }

  //     const newService = {
  //       vendorId: req.user.id,
  //       vendorName: req.user.name,
  //       serviceName,
  //       category,
  //       description,
  //       price: Number(price),
  //       location,
  //       images: [images],
  //       status: "pending",
  //       isActive: true,
  //       createdAt: new Date(),
  //     };

  //     const result = await servicesCollection.insertOne(newService);

  //     res.status(201).send({
  //       success: true,
  //       message: "Service submitted for admin approval!",
  //       insertedId: result.insertedId,
  //     });
  //   } catch (error) {
  //     console.error("Failed to add service:", error);

  //     res.status(500).send({
  //       success: false,
  //       message: "Failed to add service.",
  //     });
  //   }
  // });
  // Get services belonging to the logged-in vendor
  // app.get("/vendor/services", verifyUser, verifyVendor, async (req, res) => {
  //   try {
  //     const services = await servicesCollection
  //       .find({ vendorId: req.user.id })
  //       .sort({ createdAt: -1 })
  //       .toArray();

  //     res.status(200).send({
  //       success: true,
  //       services,
  //     });
  //   } catch (error) {
  //     console.error("Failed to fetch vendor services:", error);

  //     res.status(500).send({
  //       success: false,
  //       message: "Failed to fetch your services.",
  //     });
  //   }
  // });
  // Get all services for admin
  // app.get("/admin/services", verifyUser, verifyAdmin, async (req, res) => {
  //   try {
  //     const services = await servicesCollection
  //       .find({})
  //       .sort({ createdAt: -1 })
  //       .toArray();

  //     res.status(200).send({
  //       success: true,
  //       services,
  //     });
  //   } catch (error) {
  //     console.error("Failed to fetch admin services:", error);

  //     res.status(500).send({
  //       success: false,
  //       message: "Failed to fetch services.",
  //     });
  //   }
  // });
// Get All Users (Admin Only)
// app.get("/admin/users", verifyUser, verifyAdmin, async (req, res) => {
//   try {
//     const users = await usersCollection
//       .find(
//         {},
//         {
//           projection: {
//             name: 1,
//             email: 1,
//             image: 1,
//             role: 1,
//             isBlocked: 1,
//             createdAt: 1,
//           },
//         }
//       )
//       .sort({ createdAt: -1 })
//       .toArray();

//     res.status(200).send({
//       success: true,
//       users,
//     });
//   } catch (error) {
//     console.error("Failed to fetch users:", error);

//     res.status(500).send({
//       success: false,
//       message: "Failed to load users.",
//     });
//   }
// });
// Block or Unblock User (Admin Only)
// app.patch(
//   "/admin/users/:id/status",
//   verifyUser,
//   verifyAdmin,
//   async (req, res) => {
//     try {
//       const { id } = req.params;
//       const { isBlocked } = req.body;

//       if (!ObjectId.isValid(id)) {
//         return res.status(400).send({
//           success: false,
//           message: "Invalid user ID.",
//         });
//       }

//       if (typeof isBlocked !== "boolean") {
//         return res.status(400).send({
//           success: false,
//           message: "Invalid account status.",
//         });
//       }

//       const result = await usersCollection.updateOne(
//         {
//           _id: new ObjectId(id),
//           role: { $in: ["customer", "vendor"] },
//         },
//         {
//           $set: {
//             isBlocked,
//             updatedAt: new Date(),
//           },
//         }
//       );

//       if (result.matchedCount === 0) {
//         return res.status(404).send({
//           success: false,
//           message: "Customer or vendor not found.",
//         });
//       }

//       res.status(200).send({
//         success: true,
//         message: isBlocked
//           ? "User blocked successfully."
//           : "User unblocked successfully.",
//       });
//     } catch (error) {
//       console.error("Failed to update user status:", error);

//       res.status(500).send({
//         success: false,
//         message: "Failed to update user status.",
//       });
//     }
//   }
// );
  // Approve or reject a service
// app.patch(
//   "/admin/services/:id/status",
//   verifyUser,
//   verifyAdmin,
//   async (req, res) => {
//     try {
//       const { id } = req.params;
//       const { status } = req.body;

//       if (!ObjectId.isValid(id)) {
//         return res.status(400).send({
//           success: false,
//           message: "Invalid service ID.",
//         });
//       }

//       if (!["approved", "rejected"].includes(status)) {
//         return res.status(400).send({
//           success: false,
//           message: "Invalid service status.",
//         });
//       }

//       const result = await servicesCollection.updateOne(
//         {
//           _id: new ObjectId(id),
//           status: "pending",
//         },
//         {
//           $set: {
//             status,
//             updatedAt: new Date(),
//           },
//         }
//       );

//       if (result.matchedCount === 0) {
//         return res.status(404).send({
//           success: false,
//           message: "Pending service not found.",
//         });
//       }

//       res.status(200).send({
//         success: true,
//         message: `Service ${status} successfully.`,
//       });
//     } catch (error) {
//       console.error("Failed to update service status:", error);

//       res.status(500).send({
//         success: false,
//         message: "Failed to update service status.",
//       });
//     }
//   }
// );
// Delete a service (Admin only)
// app.delete(
//   "/admin/services/:id",
//   verifyUser,
//   verifyAdmin,
//   async (req, res) => {
//     try {
//       const { id } = req.params;

//       if (!ObjectId.isValid(id)) {
//         return res.status(400).send({
//           success: false,
//           message: "Invalid service ID.",
//         });
//       }

//       const result = await servicesCollection.deleteOne({
//         _id: new ObjectId(id),
//       });

//       if (result.deletedCount === 0) {
//         return res.status(404).send({
//           success: false,
//           message: "Service not found.",
//         });
//       }

//       res.status(200).send({
//         success: true,
//         message: "Service deleted successfully.",
//       });
//     } catch (error) {
//       console.error("Failed to delete service:", error);

//       res.status(500).send({
//         success: false,
//         message: "Failed to delete service.",
//       });
//     }
//   }
// );
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
