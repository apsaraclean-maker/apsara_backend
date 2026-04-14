import express from "express"
import {config} from "dotenv"
import MongoStore from "connect-mongo";
import session from "express-session";
import ConnectDB from "./db/db_connection.js";
config()

const app = express()
ConnectDB()
declare module "express-session" {
  interface SessionData {
    token?: string;
  }
}

// app.set("trust proxy", 1); on it in nginx

const allowedOrigins:any = [
  "https://funny-llama-333beb.netlify.app/",
  "http://localhost:3000"
];

app.use((req, res, next) => {
  const origin:any = req.headers.origin;

  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  next();
});

app.use(
  session({
    secret: process.env.SESSION_SECRET as any,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: process.env.MONGO_DB_URI as any,
      collectionName: "sessions",
    }),
    cookie: {
    //   maxAge: 1000 * 60 * 60 * 24, // 1 day
      httpOnly: true,
      secure: false, // set true in production with HTTPS
    },
  })
);


app.get("/",(req,res)=>{
    res.json({"message":"Apsara Server API Running"})
})



// For RENDER ONLY
app.get("/check-status",async(req,res)=>{
  try {
    console.log("Inside check");
    
    setTimeout(()=>{
      fetch("https://apsara-backend-766y.onrender.com/check-status")
    },5*60*1000)
    res.json({message:"Ok"})
  } catch (error) {
    
  }
})



app.listen(process.env.PORT,()=>{
    console.log("Server Running...")
})