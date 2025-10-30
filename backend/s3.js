const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const crypto = require('crypto');

// Initialize S3 Client
const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const BUCKET_NAME = process.env.S3_BUCKET_NAME;

/**
 * Upload base64 image to S3
 * @param {string} base64Data - Base64 encoded image data (with or without data URL prefix)
 * @param {string} folder - Folder name in S3 (e.g., 'submissions', 'results')
 * @returns {Promise<string>} - S3 URL
 */
async function uploadImageToS3(base64Data, folder = 'images') {
  try {
    // Remove data URL prefix if present
    const base64Image = base64Data.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Image, 'base64');
    
    // Generate unique filename
    const timestamp = Date.now();
    const randomString = crypto.randomBytes(8).toString('hex');
    const filename = `${folder}/${timestamp}-${randomString}.jpg`;
    
    // Upload to S3
    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: BUCKET_NAME,
        Key: filename,
        Body: buffer,
        ContentType: 'image/jpeg',
        CacheControl: 'max-age=31536000' // 1 year cache
      }
    });
    
    await upload.done();
    
    // Return public URL
    return `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${filename}`;
  } catch (error) {
    console.error('S3 upload error:', error);
    throw new Error(`Failed to upload image to S3: ${error.message}`);
  }
}

/**
 * Delete image from S3
 * @param {string} imageUrl - S3 URL to delete
 */
async function deleteImageFromS3(imageUrl) {
  try {
    // Extract key from URL
    const url = new URL(imageUrl);
    const key = url.pathname.substring(1); // Remove leading slash
    
    const command = new DeleteObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key
    });
    
    await s3Client.send(command);
    console.log(`Deleted from S3: ${key}`);
  } catch (error) {
    console.error('S3 delete error:', error);
    // Don't throw - allow operation to continue even if delete fails
  }
}

/**
 * Upload multiple images to S3
 * @param {Array<string>} base64Images - Array of base64 images
 * @param {string} folder - Folder name in S3
 * @returns {Promise<Array<string>>} - Array of S3 URLs
 */
async function uploadMultipleImagesToS3(base64Images, folder = 'images') {
  const uploadPromises = base64Images.map(img => uploadImageToS3(img, folder));
  return Promise.all(uploadPromises);
}

module.exports = {
  uploadImageToS3,
  deleteImageFromS3,
  uploadMultipleImagesToS3
};

