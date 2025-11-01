require('dotenv').config(); // Load environment variables FIRST

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const { uploadImageToS3, deleteImageFromS3, uploadMultipleImagesToS3 } = require('./s3');

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI)
.then(() => console.log('✅ Connected to MongoDB'))
.catch(err => console.error('❌ MongoDB connection error:', err));

// Submission Schema
const submissionSchema = new mongoose.Schema({
  name: { type: String, required: true },
  photo: { type: String, required: true }, // S3 URL
  prompt: { type: String, required: true },
  customText: { type: String, default: '' },
  status: { 
    type: String, 
    enum: ['pending', 'approved', 'processing', 'completed', 'rejected', 'failed'],
    default: 'pending'
  },
  generatedImages: [{
    url: String, // S3 URL
    filename: String,
    createdAt: { type: Date, default: Date.now }
  }],
  approvedAt: { type: Date },
  processingStartedAt: { type: Date },
  retryCount: { type: Number, default: 0 },
  failureReason: { type: String },
  processingLogs: [{
    timestamp: { type: Date, default: Date.now },
    message: String,
    level: { type: String, enum: ['info', 'warning', 'error'], default: 'info' }
  }],
  createdAt: { type: Date, default: Date.now },
  processedAt: { type: Date }
});

const Submission = mongoose.model('Submission', submissionSchema);

// Preset Schema
const presetSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  prompt: { type: String, required: true },
  customText: { type: String, default: '' }
});

const Preset = mongoose.model('Preset', presetSchema);

// Capture Settings Schema
const captureSettingsSchema = new mongoose.Schema({
  // Prompt Configuration
  promptMode: {
    type: String,
    enum: ['free', 'locked', 'presets', 'suggestions'],
    default: 'free'
  },
  lockedPromptTitle: { type: String, default: '' },
  lockedPromptValue: { type: String, default: '' },
  promptPresets: [{
    name: String,
    value: String
  }],
  
  // Custom Text Configuration
  customTextMode: {
    type: String,
    enum: ['free', 'locked', 'presets', 'suggestions'],
    default: 'free'
  },
  lockedCustomTextValue: { type: String, default: '' },
  customTextPresets: [{
    name: String,
    value: String
  }],
  
  updatedAt: { type: Date, default: Date.now }
});

const CaptureSettings = mongoose.model('CaptureSettings', captureSettingsSchema);

// Authentication middleware
const authenticateCapture = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'No authorization header' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'capture' && decoded.role !== 'admin') {
      return res.status(403).json({ error: 'Invalid role' });
    }
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

const authenticateAdmin = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'No authorization header' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

const authenticateProcessor = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'No authorization header' });
  }

  const token = authHeader.split(' ')[1];
  
  // Check if it's the processor secret
  if (token === process.env.PROCESSOR_SECRET) {
    req.user = { role: 'processor' };
    next();
  } else {
    return res.status(401).json({ error: 'Invalid processor secret' });
  }
};

const authenticateAdminOrProcessor = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'No authorization header' });
  }

  const token = authHeader.split(' ')[1];
  
  // Check if it's the processor secret
  if (token === process.env.PROCESSOR_SECRET) {
    req.user = { role: 'processor' };
    return next();
  }
  
  // Otherwise check if it's a valid admin JWT
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

// Login endpoints
app.post('/api/auth/login/capture', async (req, res) => {
  try {
    const { password } = req.body;
    
    if (password === process.env.CAPTURE_PASSWORD) {
      const token = jwt.sign({ role: 'capture' }, process.env.JWT_SECRET, { expiresIn: '24h' });
      return res.json({ token, role: 'capture' });
    }
    
    return res.status(401).json({ error: 'Invalid password' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/login/admin', async (req, res) => {
  try {
    const { password } = req.body;
    
    if (password === process.env.ADMIN_PASSWORD) {
      const token = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '24h' });
      return res.json({ token, role: 'admin' });
    }
    
    return res.status(401).json({ error: 'Invalid password' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Submission endpoints

// Create new submission (capture page)
app.post('/api/submissions', authenticateCapture, async (req, res) => {
  try {
    const { name, photo, prompt, customText } = req.body;
    
    if (!name || !photo || !prompt) {
      return res.status(400).json({ error: 'Name, photo, and prompt are required' });
    }

    // Upload photo to S3
    console.log('Uploading photo to S3...');
    const photoUrl = await uploadImageToS3(photo, 'submissions');
    console.log(`Photo uploaded: ${photoUrl}`);

    const submission = new Submission({
      name,
      photo: photoUrl, // Store S3 URL instead of base64
      prompt,
      customText: customText || '',
      status: 'pending'
    });

    await submission.save();
    
    res.status(201).json({ 
      message: 'Submission saved successfully',
      submissionId: submission._id
    });
  } catch (error) {
    console.error('Submission error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all submissions (admin page)
app.get('/api/submissions', authenticateAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    const query = status ? { status } : {};
    
    const submissions = await Submission.find(query)
      .sort({ createdAt: -1 })
      .select('-photo'); // Don't send full photos in list, only thumbnails
    
    res.json(submissions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// SPECIFIC ROUTES MUST COME BEFORE PARAMETRIC ROUTES (:id)

// Get stuck processing submissions (processor only)
app.get('/api/submissions/stuck', authenticateProcessor, async (req, res) => {
  try {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    
    const stuckSubmissions = await Submission.find({
      status: 'processing',
      processingStartedAt: { $lt: twoMinutesAgo }
    });

    // Reset them to approved
    for (const sub of stuckSubmissions) {
      sub.status = 'approved';
      sub.retryCount += 1;
      sub.processingLogs.push({
        message: 'Reset from stuck processing state',
        level: 'warning',
        timestamp: new Date()
      });
      await sub.save();
    }

    res.json({ reset: stuckSubmissions.length, submissions: stuckSubmissions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get approved submissions for processing (local processor)
app.get('/api/submissions/approved/queue', async (req, res) => {
  try {
    const { processorSecret } = req.query;
    
    if (processorSecret !== process.env.PROCESSOR_SECRET) {
      return res.status(401).json({ error: 'Invalid processor secret' });
    }

    // Get approved submissions sorted by approvedAt (oldest first), then by retryCount (fewer retries first)
    const submissions = await Submission.find({ status: 'approved' })
      .sort({ approvedAt: 1, retryCount: 1 })
      .limit(1); // Process one at a time for reliability
    
    res.json(submissions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single submission with full photo (admin page)
app.get('/api/submissions/:id', authenticateAdmin, async (req, res) => {
  try {
    const submission = await Submission.findById(req.params.id);
    
    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }
    
    res.json(submission);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get submission thumbnail
app.get('/api/submissions/:id/thumbnail', authenticateAdmin, async (req, res) => {
  try {
    const submission = await Submission.findById(req.params.id).select('photo name');
    
    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }
    
    res.json({ photo: submission.photo, name: submission.name });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Proxy download endpoint to bypass CORS
app.get('/api/download', authenticateAdmin, async (req, res) => {
  try {
    const { url, filename } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'URL parameter is required' });
    }

    // Download image from S3
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    const imageBuffer = Buffer.from(response.data);
    
    // Extract ComfyUI number from filename
    // Example: "sticker_1_ComfyUI_temp_tqhca_00073_.png" -> "00073"
    let imageNumber = '00000';
    if (filename) {
      // Look for 5-digit number pattern in the filename
      const numberMatch = filename.match(/(\d{5})/);
      if (numberMatch) {
        imageNumber = numberMatch[1]; // "00073"
      }
    }
    
    // Create filename: LumStickers00277.png
    const downloadFilename = `LumStickers${imageNumber}.png`;
    
    // Get image metadata to calculate aspect ratio
    const metadata = await sharp(imageBuffer).metadata();
    const aspectRatio = metadata.width / metadata.height;
    
    // Process image: resize to exactly 2.5 inches at 600 DPI (1500 pixels height)
    const targetHeight = 1500; // 2.5 inches * 600 DPI
    const targetWidth = Math.round(targetHeight * aspectRatio);
    
    console.log('🎨 Starting download processing...');
    
    // Step 1: Resize
    console.log(`📏 Resizing to ${targetWidth}x${targetHeight}px (2.5" @ 600 DPI)`);
    let processedImage = await sharp(imageBuffer)
      .resize(targetWidth, targetHeight, {
        fit: 'fill',
        kernel: 'lanczos3'
      })
      .toBuffer();
    
    // Step 2: Conservative alpha cleanup
    console.log('🔧 Cleaning alpha edges (RGB untouched)...');
    const { data, info } = await sharp(processedImage)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    
    const width = info.width;
    const height = info.height;
    
    // Simple alpha threshold - removes semi-transparent fringing
    for (let i = 0; i < width * height; i++) {
      const alphaIdx = i * 4 + 3;
      data[alphaIdx] = data[alphaIdx] > 240 ? 255 : 0;
    }
    
    // Step 3: Fill interior holes only (not exterior edges)
    console.log('🔧 Filling interior holes only...');
    
    // Create a map to track exterior transparent areas
    const isExterior = new Uint8Array(width * height);
    
    // Flood fill from all edges to mark exterior transparent pixels
    const queue = [];
    
    // Add all transparent edge pixels to queue
    for (let x = 0; x < width; x++) {
      // Top edge
      if (data[x * 4 + 3] === 0) {
        queue.push(x);
        isExterior[x] = 1;
      }
      // Bottom edge
      const bottomIdx = (height - 1) * width + x;
      if (data[bottomIdx * 4 + 3] === 0) {
        queue.push(bottomIdx);
        isExterior[bottomIdx] = 1;
      }
    }
    for (let y = 0; y < height; y++) {
      // Left edge
      const leftIdx = y * width;
      if (data[leftIdx * 4 + 3] === 0) {
        queue.push(leftIdx);
        isExterior[leftIdx] = 1;
      }
      // Right edge
      const rightIdx = y * width + (width - 1);
      if (data[rightIdx * 4 + 3] === 0) {
        queue.push(rightIdx);
        isExterior[rightIdx] = 1;
      }
    }
    
    // Flood fill to mark all exterior transparent areas
    while (queue.length > 0) {
      const idx = queue.shift();
      const x = idx % width;
      const y = Math.floor(idx / width);
      
      // Check 4 neighbors
      const neighbors = [
        { nx: x - 1, ny: y },
        { nx: x + 1, ny: y },
        { nx: x, ny: y - 1 },
        { nx: x, ny: y + 1 }
      ];
      
      for (const { nx, ny } of neighbors) {
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          const nIdx = ny * width + nx;
          // If neighbor is transparent and not yet marked as exterior
          if (data[nIdx * 4 + 3] === 0 && isExterior[nIdx] === 0) {
            isExterior[nIdx] = 1;
            queue.push(nIdx);
          }
        }
      }
    }
    
    // Fill interior holes: transparent pixels NOT marked as exterior
    for (let i = 0; i < width * height; i++) {
      if (data[i * 4 + 3] === 0 && isExterior[i] === 0) {
        // This is an interior hole - fill it
        data[i * 4 + 3] = 255;
      }
    }
    
    // Rebuild
    processedImage = await sharp(data, {
      raw: {
        width: info.width,
        height: info.height,
        channels: 4
      }
    })
    .withMetadata({
      density: 600
    })
    .png({ 
      compressionLevel: 9,
      quality: 90,
      density: 600
    })
    .toBuffer();
    
    console.log('✅ Download ready!');
    
    // Send the processed image with correct headers
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename}"`);
    res.send(processedImage);
  } catch (error) {
    console.error('Download proxy error:', error.message);
    res.status(500).json({ error: 'Failed to download image' });
  }
});

// Update submission details (admin page or processor)
app.patch('/api/submissions/:id', authenticateAdminOrProcessor, async (req, res) => {
  try {
    const { photo, prompt, customText, processingStartedAt } = req.body;
    
    const updateData = {};
    if (photo !== undefined) updateData.photo = photo;
    if (prompt !== undefined) updateData.prompt = prompt;
    if (customText !== undefined) updateData.customText = customText;
    if (processingStartedAt !== undefined) updateData.processingStartedAt = processingStartedAt;

    const submission = await Submission.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true }
    );

    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    res.json(submission);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update submission status (admin page or processor)
app.patch('/api/submissions/:id/status', authenticateAdminOrProcessor, async (req, res) => {
  try {
    const { status } = req.body;
    
    if (!['pending', 'approved', 'processing', 'completed', 'rejected', 'failed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const submission = await Submission.findByIdAndUpdate(
      req.params.id,
      { status, processedAt: status === 'completed' ? new Date() : undefined },
      { new: true }
    );

    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    res.json(submission);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Approve submission (admin only)
app.patch('/api/submissions/:id/approve', authenticateAdmin, async (req, res) => {
  try {
    const submission = await Submission.findByIdAndUpdate(
      req.params.id,
      { 
        status: 'approved',
        approvedAt: new Date(),
        retryCount: 0
      },
      { new: true }
    );

    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    res.json(submission);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add processing log (processor only)
app.post('/api/submissions/:id/logs', authenticateProcessor, async (req, res) => {
  try {
    const { message, level } = req.body;
    
    const submission = await Submission.findByIdAndUpdate(
      req.params.id,
      { 
        $push: { 
          processingLogs: {
            message,
            level: level || 'info',
            timestamp: new Date()
          }
        }
      },
      { new: true }
    );

    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    res.json(submission);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Regenerate submission (admin only)
app.post('/api/submissions/:id/regenerate', authenticateAdmin, async (req, res) => {
  try {
    const originalSubmission = await Submission.findById(req.params.id);
    
    if (!originalSubmission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    // Create a duplicate submission for regeneration
    const newSubmission = new Submission({
      name: originalSubmission.name,
      photo: originalSubmission.photo,
      prompt: originalSubmission.prompt,
      customText: originalSubmission.customText,
      status: 'approved',
      approvedAt: new Date(),
      retryCount: 0,
      generatedImages: [],
      processingLogs: [{
        message: `Regenerated from submission ${originalSubmission._id}`,
        level: 'info',
        timestamp: new Date()
      }]
    });

    await newSubmission.save();

    res.json(newSubmission);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add submission to queue (for completed/rejected/failed entries)
app.post('/api/submissions/:id/add-to-queue', authenticateAdmin, async (req, res) => {
  try {
    const submission = await Submission.findById(req.params.id);
    
    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    // Set status to approved to add to queue
    submission.status = 'approved';
    submission.approvedAt = new Date();
    submission.retryCount = 0;

    await submission.save();

    res.json(submission);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Verify and fix submission status (admin only)
app.post('/api/submissions/:id/verify-status', authenticateAdmin, async (req, res) => {
  try {
    const submission = await Submission.findById(req.params.id);
    
    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    let fixed = false;
    let message = '';

    // If stuck in processing but has generated images, mark as completed
    if (submission.status === 'processing' && submission.generatedImages && submission.generatedImages.length >= 4) {
      submission.status = 'completed';
      submission.processedAt = new Date();
      await submission.save();
      fixed = true;
      message = `Fixed: Found ${submission.generatedImages.length} images, marked as completed`;
    } 
    // If stuck in processing with no images for over 2 minutes, reset to approved
    else if (submission.status === 'processing' && submission.processingStartedAt) {
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
      if (submission.processingStartedAt < twoMinutesAgo) {
        submission.status = 'approved';
        submission.retryCount = (submission.retryCount || 0) + 1;
        submission.processingStartedAt = undefined;
        await submission.save();
        fixed = true;
        message = 'Reset stuck processing submission to approved';
      } else {
        message = 'Still processing (less than 2 minutes)';
      }
    } else {
      message = `Status ${submission.status} is correct`;
    }

    res.json({ 
      fixed, 
      message,
      submission 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mark submission as failed (processor only)
app.patch('/api/submissions/:id/fail', authenticateProcessor, async (req, res) => {
  try {
    const { reason } = req.body;
    
    const submission = await Submission.findByIdAndUpdate(
      req.params.id,
      { 
        status: 'failed',
        failureReason: reason,
        $push: {
          processingLogs: {
            message: `Failed: ${reason}`,
            level: 'error',
            timestamp: new Date()
          }
        }
      },
      { new: true }
    );

    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    res.json(submission);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete submission (admin page)
app.delete('/api/submissions/:id', authenticateAdmin, async (req, res) => {
  try {
    const submission = await Submission.findById(req.params.id);
    
    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }
    
    // Delete images from S3
    try {
      await deleteImageFromS3(submission.photo);
      
      // Delete generated images if any
      if (submission.generatedImages && submission.generatedImages.length > 0) {
        for (const img of submission.generatedImages) {
          if (img.url) {
            await deleteImageFromS3(img.url);
          }
        }
      }
    } catch (s3Error) {
      console.error('Error deleting from S3:', s3Error);
      // Continue with database deletion even if S3 deletion fails
    }
    
    // Delete from database
    await Submission.findByIdAndDelete(req.params.id);
    
    res.json({ message: 'Submission deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update submission with generated images (local processor)
app.patch('/api/submissions/:id/images', async (req, res) => {
  try {
    // Verify processor secret
    const { processorSecret, generatedImages } = req.body;
    
    if (processorSecret !== process.env.PROCESSOR_SECRET) {
      return res.status(401).json({ error: 'Invalid processor secret' });
    }

    // Upload generated images to S3
    console.log(`Uploading ${generatedImages.length} generated images to S3...`);
    const uploadedImages = [];
    
    for (const img of generatedImages) {
      try {
        const imageUrl = await uploadImageToS3(img.data, 'results');
        uploadedImages.push({
          url: imageUrl, // Store S3 URL instead of base64
          filename: img.filename,
          createdAt: img.createdAt || new Date()
        });
        console.log(`Uploaded: ${img.filename}`);
      } catch (uploadError) {
        console.error(`Failed to upload ${img.filename}:`, uploadError);
        // Continue with other images even if one fails
      }
    }

    const submission = await Submission.findByIdAndUpdate(
      req.params.id,
      { 
        generatedImages: uploadedImages,
        status: 'completed',
        processedAt: new Date()
      },
      { new: true }
    );

    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    res.json(submission);
  } catch (error) {
    console.error('Error updating submission with images:', error);
    res.status(500).json({ error: error.message });
  }
});

// Preset endpoints

// Get all presets (admin page)
app.get('/api/presets', authenticateAdmin, async (req, res) => {
  try {
    const presets = await Preset.find().sort({ name: 1 });
    res.json(presets);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create preset (admin page)
app.post('/api/presets', authenticateAdmin, async (req, res) => {
  try {
    const { name, prompt, customText } = req.body;
    
    if (!name || !prompt) {
      return res.status(400).json({ error: 'Name and prompt are required' });
    }

    const preset = new Preset({ name, prompt, customText: customText || '' });
    await preset.save();
    
    res.status(201).json(preset);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ error: 'Preset name already exists' });
    }
    res.status(500).json({ error: error.message });
  }
});

// Delete preset (admin page)
app.delete('/api/presets/:id', authenticateAdmin, async (req, res) => {
  try {
    const preset = await Preset.findByIdAndDelete(req.params.id);
    
    if (!preset) {
      return res.status(404).json({ error: 'Preset not found' });
    }
    
    res.json({ message: 'Preset deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== CAPTURE SETTINGS ROUTES =====

// Get capture settings (public - capture page needs this)
app.get('/api/capture-settings', async (req, res) => {
  try {
    let settings = await CaptureSettings.findOne();
    
    if (!settings) {
      // Create default settings
      settings = await CaptureSettings.create({
        mode: 'free',
        lockedPrompt: '',
        lockedCustomText: '',
        presetOptions: []
      });
    }
    
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update capture settings (admin only)
app.put('/api/capture-settings', authenticateAdmin, async (req, res) => {
  try {
    const { 
      promptMode, 
      lockedPromptTitle,
      lockedPromptValue, 
      promptPresets,
      customTextMode,
      lockedCustomTextValue,
      customTextPresets
    } = req.body;
    
    let settings = await CaptureSettings.findOne();
    
    if (!settings) {
      settings = new CaptureSettings();
    }
    
    settings.promptMode = promptMode || 'free';
    settings.lockedPromptTitle = lockedPromptTitle || '';
    settings.lockedPromptValue = lockedPromptValue || '';
    settings.promptPresets = promptPresets || [];
    
    settings.customTextMode = customTextMode || 'free';
    settings.lockedCustomTextValue = lockedCustomTextValue || '';
    settings.customTextPresets = customTextPresets || [];
    
    settings.updatedAt = new Date();
    
    await settings.save();
    
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Serve static frontend files (after API routes)
app.use(express.static(path.join(__dirname, '../frontend')));

// Root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Frontend: http://localhost:${PORT}`);
  console.log(`📍 API endpoint: http://localhost:${PORT}/api`);
});

