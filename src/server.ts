import express from "express"
import {config} from "dotenv"
config()

const app = express()


app.get("/",(req,res)=>{
    res.json({"message":"Apsara Server API Running"})
})



app.listen(process.env.PORT,()=>{
    console.log("Server Running...")
})