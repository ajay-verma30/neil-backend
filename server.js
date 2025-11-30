const express = require('express')
const app = express();
const cors = require('cors');
require('dotenv').config();
const cookieParser = require("cookie-parser");
const path = require('path')
const authRoutes = require("./routes/authRoutes");
const Stripe = require('stripe')
const sanmarRoutes = require('./routes/sanmar.js')

app.set('trust proxy', 1);
app.use(cookieParser());
app.use(express.json());

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);

      const allowedOrigins = [
        "http://localhost:3002",
        "http://localhost:3001",
        "https://neil-admin.vercel.app",
        "https://my-production-domain.com"
      ];

      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.warn("❌ CORS Blocked:", origin);
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
    preflightContinue: false,
    optionsSuccessStatus: 200,
  })
);



app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.get('/', (req,res)=>{
    res.status(200).json({message:"Working"});
})

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

app.use('/organization',require('./routes/organizations'))
app.use('/users',require('./routes/users'))
app.use('/groups',require('./routes/groups'))
app.use('/products',require('./routes/products'))
app.use('/logos',require('./routes/logos.js'))
app.use('/categories',require('./routes/categories.js'))
app.use('/sub-categories', require('./routes/sub-categories'))
app.use('/customization', require('./routes/customization.js'))
app.use('/checkout', require('./routes/orders.js'))
app.use('/address', require('./routes/address.js'))
app.use('/cart', require('./routes/cart.js'))
app.use('/sidebar', require('./routes/sidebar.js'))
app.use("/auth", authRoutes);
app.use("/api/sanmar", sanmarRoutes);

app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'USD',
      automatic_payment_methods: { enabled: true },
    });

    res.status(200).json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});



const port = process.env.PORT || 3000;

app.listen(port,()=>{
    console.log(`http://localhost:${port}`)
})
