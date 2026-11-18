
import cors from "cors";
import express from "express";
import "dotenv/config";
import { MongoClient } from "mongodb";

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB connection
const client = new MongoClient(process.env.MONGODB_URI);

try {
  await client.connect();
  console.log("Successfully connected to MongoDB!");

  const db = client.db("Wedora-DB");

  // Collections
  const usersCollection = db.collection("users");
  const servicesCollection = db.collection("services");
  const bookingsCollection = db.collection("bookings");
  const transactionsCollection = db.collection("transactions");

  // Root route
  app.get("/", (req, res) => {
    res.send("Hello Wedora Server");
  });

  // Start server
  app.listen(PORT, () => {
    console.log(`Wedora server listening on port ${PORT}`);
  });

} catch (error) {
  console.error("MongoDB connection failed:", error);
  process.exit(1);
}

export default app;
