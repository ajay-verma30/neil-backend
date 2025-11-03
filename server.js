const express = require('express')
const app = express();
const cors = require('cors');
require('dotenv').config();
const cookieParser = require("cookie-parser");
const path = require('path')
const authRoutes = require("./routes/authRoutes");

app.set('trust proxy', 1);
app.use(cookieParser());
app.use(express.json());

const allowedOrigins = [
  "http://localhost:3002",
  "http://localhost:3001", 
  "https://my-production-domain.com",
  "https://neil-admin.vercel.app"
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);

    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.get('/', (req,res)=>{
    res.status(200).json({message:"Working"});
})

app.use('/organization',require('./routes/organizations'))
app.use('/users',require('./routes/users'))
app.use('/groups',require('./routes/groups'))
app.use('/products',require('./routes/products'))
app.use('/logos',require('./routes/logos.js'))
app.use('/sub-categories', require('./routes/sub-categories'))
app.use('/customization', require('./routes/customization.js'))
app.use('/checkout', require('./routes/orders.js'))
app.use('/address', require('./routes/address.js'))
app.use('/cart', require('./routes/cart.js'))
app.use("/auth", authRoutes);


const port = process.env.PORT || 3000;

app.listen(port,()=>{
    console.log(`http://localhost:${port}`)
})
