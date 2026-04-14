import { config } from "dotenv";
import mongoose from "mongoose";
config()

// const MONGO_URI = "mongodb://127.0.0.1:27017/session-db";
const MONGO_URI : any = process.env.MONGO_DB_URI;
export default function ConnectDB (){

  mongoose.connect(MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.error(err));
} 