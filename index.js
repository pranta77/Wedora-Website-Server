
import cors from "cors";
import express from "express";
import "dotenv/config";
import { MongoClient } from "mongodb";

import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { toNodeHandler } from "better-auth/node";

const app = express();
const PORT = process.env.PORT || 5000;

// CORS
app.use(
  cors({
    origin: "http://localhost:3000",
    credentials: true,
  })
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
