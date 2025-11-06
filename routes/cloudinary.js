const { v2: cloudinary } = require("cloudinary");

// ⚙️ Cloudinary Configuration
cloudinary.config({
  cloud_name: "daa5nwpfn",
  api_key: "777368993482171",
  api_secret: "8_5GCAbTccw8TJfU0ZP8p0KcZlk",
});

/* -------------------------------------------- */
/* ☁️ Upload Buffer to Cloudinary */
/* -------------------------------------------- */
const uploadToCloudinary = async (buffer, folder) => {
  try {
    const base64 = `data:image/jpeg;base64,${buffer.toString("base64")}`;
    const result = await cloudinary.uploader.upload(base64, { folder });
    return result.secure_url;
  } catch (err) {
    console.error("❌ Cloudinary upload failed:", err);
    throw err;
  }
};

/* -------------------------------------------- */
/* 🗑️ Delete from Cloudinary by Public ID */
/* -------------------------------------------- */
const deleteFromCloudinary = async (publicId) => {
  try {
    await cloudinary.uploader.destroy(publicId);
    console.log("🗑️ Deleted from Cloudinary:", publicId);
  } catch (err) {
    console.error("❌ Cloudinary delete failed:", err);
  }
};

/* -------------------------------------------- */
/* 🔍 Extract Cloudinary Public ID from URL */
/* -------------------------------------------- */
const extractPublicId = (url) => {
  if (!url) return null;
  const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-zA-Z]+$/);
  return match ? match[1] : null;
};

module.exports = {
  cloudinary,
  uploadToCloudinary,
  deleteFromCloudinary,
  extractPublicId,
};
