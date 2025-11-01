const { v2: cloudinary } = require("cloudinary");

cloudinary.config({
  cloud_name: "daa5nwpfn",
  api_key: "777368993482171",
  api_secret: "8_5GCAbTccw8TJfU0ZP8p0KcZlk",
});

module.exports = { cloudinary };
