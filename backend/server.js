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
const { sendCompletionNotifications } = require('./notifications');

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI)
.then(() => console.log('✅ Connected to MongoDB'))
.catch(err => console.error('❌ MongoDB connection error:', err));

// Event Schema
const eventSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String, default: '' },
  eventDate: { type: Date, required: true },
  isArchived: { type: Boolean, default: false },
  
  // Per-event Capture Settings (embedded)
  captureSettings: {
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
    customTextMode: { 
      type: String, 
      enum: ['free', 'locked', 'presets', 'suggestions'], 
      default: 'free' 
    },
    lockedCustomTextValue: { type: String, default: '' },
    customTextPresets: [{
      name: String,
      value: String
    }]
  },
  
  // Per-event Branding Settings (embedded)
  brandingSettings: {
    enabled: { type: Boolean, default: false },
    logoUrl: { type: String, default: '' }, // S3 URL
    position: {
      x: { type: Number, default: 50 }, // Percentage (0-100)
      y: { type: Number, default: 10 }  // Percentage (0-100)
    },
    size: {
      width: { type: Number, default: 20 }, // Percentage of sticker width
      maintainAspectRatio: { type: Boolean, default: true }
    },
    opacity: { type: Number, default: 100 } // 0-100
  },
  
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const Event = mongoose.model('Event', eventSchema);

// Submission Schema
const submissionSchema = new mongoose.Schema({
  eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
  name: { type: String, required: true },
  email: { type: String, default: '' },
  phone: { type: String, default: '' },
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

// Note: CaptureSettings is now embedded in Event schema

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
    const { eventId, name, email, phone, photo, prompt, customText } = req.body;
    
    if (!eventId || !name || !photo || !prompt) {
      return res.status(400).json({ error: 'Event, name, photo, and prompt are required' });
    }
    
    // Verify event exists and is not archived
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    if (event.isArchived) {
      return res.status(400).json({ error: 'Cannot submit to archived event' });
    }

    // Upload photo to S3
    console.log('Uploading photo to S3...');
    const photoUrl = await uploadImageToS3(photo, 'submissions');
    console.log(`Photo uploaded: ${photoUrl}`);

    const submission = new Submission({
      eventId,
      name,
      email: email || '',
      phone: phone || '',
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

// Get all submissions (admin page) - now requires eventId
app.get('/api/submissions', authenticateAdmin, async (req, res) => {
  try {
    const { eventId, status, limit, skip } = req.query;
    
    // Build query
    const query = {};
    if (eventId) {
      query.eventId = eventId;
    }
    if (status) {
      query.status = status;
    }
    
    // Pagination parameters
    const limitNum = parseInt(limit) || 50; // Default 50 per page
    const skipNum = parseInt(skip) || 0;
    
    // Get total count for pagination info
    const total = await Submission.countDocuments(query);
    
    const submissions = await Submission.find(query)
      .populate('eventId', 'name')
      .sort({ createdAt: -1 })
      .limit(limitNum)
      .skip(skipNum);
    // Photo URLs (S3) are now included for fast loading
    
    res.json({
      submissions,
      pagination: {
        total,
        limit: limitNum,
        skip: skipNum,
        hasMore: (skipNum + limitNum) < total
      }
    });
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

    // For completed/rejected/failed: set to pending (requires manual approval)
    // For processing: set to approved (retry immediately)
    if (submission.status === 'completed' || submission.status === 'rejected' || submission.status === 'failed') {
      submission.status = 'pending';
      // Clear approval timestamp since it needs re-approval
      submission.approvedAt = null;
    } else {
      submission.status = 'approved';
      submission.approvedAt = new Date();
    }
    
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

// Helper function to apply logo overlay to image
async function applyLogoOverlay(imageBase64, logoBuffer, brandingSettings, metadata) {
  try {
    // Convert base64 to buffer
    const imageBuffer = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    
    // Get image dimensions
    const imageWidth = metadata.width;
    const imageHeight = metadata.height;
    
    // Calculate logo dimensions based on percentage
    const logoWidthPercent = brandingSettings.size?.width || 20;
    const logoWidth = Math.round((logoWidthPercent / 100) * imageWidth);
    
    // Resize logo maintaining aspect ratio
    const resizedLogo = await sharp(logoBuffer)
      .resize(logoWidth, null, { 
        fit: 'inside',
        withoutEnlargement: false 
      })
      .toBuffer();
    
    // Get resized logo dimensions
    const logoMetadata = await sharp(resizedLogo).metadata();
    
    // Calculate position based on percentages
    const posX = brandingSettings.position?.x || 50;
    const posY = brandingSettings.position?.y || 10;
    
    // Convert percentages to pixels (centered on the position point)
    const left = Math.round((posX / 100) * imageWidth - (logoMetadata.width / 2));
    const top = Math.round((posY / 100) * imageHeight - (logoMetadata.height / 2));
    
    // Ensure logo stays within bounds
    const finalLeft = Math.max(0, Math.min(left, imageWidth - logoMetadata.width));
    const finalTop = Math.max(0, Math.min(top, imageHeight - logoMetadata.height));
    
    // Apply opacity to logo if needed
    const opacity = (brandingSettings.opacity || 100) / 100;
    let logoToComposite = resizedLogo;
    
    if (opacity < 1) {
      // Apply opacity by modifying the alpha channel
      const { data, info } = await sharp(resizedLogo)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      
      // Multiply alpha channel by opacity
      for (let i = 0; i < data.length; i += 4) {
        data[i + 3] = Math.round(data[i + 3] * opacity);
      }
      
      logoToComposite = await sharp(data, {
        raw: {
          width: info.width,
          height: info.height,
          channels: 4
        }
      })
        .png()
        .toBuffer();
    }
    
    // Composite logo onto image
    const compositedImage = await sharp(imageBuffer)
      .composite([{
        input: logoToComposite,
        top: finalTop,
        left: finalLeft,
        blend: 'over'
      }])
      .toBuffer();
    
    // Convert back to base64
    const base64Result = `data:image/png;base64,${compositedImage.toString('base64')}`;
    
    console.log(`✨ Logo applied at (${finalLeft}, ${finalTop}) with size ${logoMetadata.width}x${logoMetadata.height}`);
    
    return base64Result;
  } catch (error) {
    console.error('Error applying logo overlay:', error);
    throw error;
  }
}

// Update submission with generated images (local processor)
app.patch('/api/submissions/:id/images', async (req, res) => {
  try {
    // Verify processor secret
    const { processorSecret, generatedImages } = req.body;
    
    if (processorSecret !== process.env.PROCESSOR_SECRET) {
      return res.status(401).json({ error: 'Invalid processor secret' });
    }

    // Get submission with event data to check branding settings
    const submission = await Submission.findById(req.params.id).populate('eventId');
    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    const event = submission.eventId;
    
    // Debug: Log branding settings
    console.log('🔍 Event branding settings:', {
      hasEvent: !!event,
      hasBrandingSettings: !!event?.brandingSettings,
      enabled: event?.brandingSettings?.enabled,
      hasLogoUrl: !!event?.brandingSettings?.logoUrl,
      logoUrl: event?.brandingSettings?.logoUrl
    });
    
    const brandingEnabled = event?.brandingSettings?.enabled && event?.brandingSettings?.logoUrl;
    
    let logoBuffer = null;
    if (brandingEnabled) {
      console.log('🎨 Branding enabled for this event, downloading logo...');
      try {
        // Download logo from S3
        const logoResponse = await axios.get(event.brandingSettings.logoUrl, { responseType: 'arraybuffer' });
        logoBuffer = Buffer.from(logoResponse.data);
        console.log('✅ Logo downloaded successfully');
      } catch (logoError) {
        console.error('❌ Failed to download logo:', logoError.message);
        // Continue without logo if download fails
      }
    } else {
      console.log('ℹ️ Branding not enabled or logo URL missing');
    }

    // Upload generated images to S3 (with logo overlay if enabled)
    console.log(`Uploading ${generatedImages.length} generated images to S3...`);
    const uploadedImages = [];
    
    for (const img of generatedImages) {
      try {
        let imageData = img.data;
        
        // Apply logo overlay if branding is enabled
        if (brandingEnabled && logoBuffer) {
          try {
            // Get original image metadata
            const originalBuffer = Buffer.from(img.data.replace(/^data:image\/\w+;base64,/, ''), 'base64');
            const metadata = await sharp(originalBuffer).metadata();
            
            console.log(`🎨 Applying logo to ${img.filename}...`);
            imageData = await applyLogoOverlay(img.data, logoBuffer, event.brandingSettings, metadata);
            console.log(`✅ Logo applied to ${img.filename}`);
          } catch (overlayError) {
            console.error(`❌ Failed to apply logo to ${img.filename}:`, overlayError.message);
            // Continue with original image if overlay fails
          }
        }
        
        const imageUrl = await uploadImageToS3(imageData, 'results');
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

    // Update submission with uploaded images
    submission.generatedImages = uploadedImages;
    submission.status = 'completed';
    submission.processedAt = new Date();
    await submission.save();

    // Populate eventId again for response
    await submission.populate('eventId');

    // Send notifications (email + SMS) if contact info provided
    if (submission.email || submission.phone) {
      console.log('📨 Sending completion notifications...');
      try {
        const notificationResults = await sendCompletionNotifications(submission, submission.eventId);
        console.log('📨 Notification results:', notificationResults);
      } catch (notifyError) {
        console.error('📨 Notification error (non-fatal):', notifyError.message);
        // Don't fail the request if notifications fail
      }
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

// ===== EVENT ROUTES =====

// Get all events (capture page gets active only, admin gets all)
app.get('/api/events', async (req, res) => {
  try {
    const { includeArchived } = req.query;
    
    // Check if admin token provided
    let isAdmin = false;
    const authHeader = req.headers.authorization;
    if (authHeader) {
      const token = authHeader.split(' ')[1];
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        isAdmin = decoded.role === 'admin';
      } catch (e) {
        // Not admin, continue as public
      }
    }
    
    let query = {};
    
    if (!isAdmin || includeArchived !== 'true') {
      // For capture page or when not requesting archived: only show non-archived events
      query.isArchived = false;
    }
    
    const events = await Event.find(query).sort({ eventDate: -1 });
    
    // For each event, get submission counts
    const eventsWithCounts = await Promise.all(events.map(async (event) => {
      const pendingCount = await Submission.countDocuments({ eventId: event._id, status: 'pending' });
      const totalCount = await Submission.countDocuments({ eventId: event._id });
      return {
        ...event.toObject(),
        pendingCount,
        totalCount
      };
    }));
    
    res.json(eventsWithCounts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single event (public - for capture page settings)
app.get('/api/events/:id', async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    res.json(event);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create event (admin only)
app.post('/api/events', authenticateAdmin, async (req, res) => {
  try {
    const { name, description, eventDate } = req.body;
    
    if (!name || !eventDate) {
      return res.status(400).json({ error: 'Name and event date are required' });
    }
    
    const event = new Event({
      name,
      description: description || '',
      eventDate: new Date(eventDate),
      captureSettings: {
        promptMode: 'free',
        customTextMode: 'free'
      }
    });
    
    await event.save();
    res.status(201).json(event);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update event (admin only)
app.put('/api/events/:id', authenticateAdmin, async (req, res) => {
  try {
    const { name, description, eventDate, captureSettings } = req.body;
    
    const event = await Event.findById(req.params.id);
    
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    if (name) event.name = name;
    if (description !== undefined) event.description = description;
    if (eventDate) event.eventDate = new Date(eventDate);
    
    if (captureSettings) {
      event.captureSettings = {
        promptMode: captureSettings.promptMode || 'free',
        lockedPromptTitle: captureSettings.lockedPromptTitle || '',
        lockedPromptValue: captureSettings.lockedPromptValue || '',
        promptPresets: captureSettings.promptPresets || [],
        customTextMode: captureSettings.customTextMode || 'free',
        lockedCustomTextValue: captureSettings.lockedCustomTextValue || '',
        customTextPresets: captureSettings.customTextPresets || []
      };
    }
    
    event.updatedAt = new Date();
    await event.save();
    
    res.json(event);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Archive/unarchive event (admin only)
app.patch('/api/events/:id/archive', authenticateAdmin, async (req, res) => {
  try {
    const { isArchived } = req.body;
    
    const event = await Event.findByIdAndUpdate(
      req.params.id,
      { isArchived: isArchived !== false, updatedAt: new Date() },
      { new: true }
    );
    
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    res.json(event);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete event (admin only - only if no submissions)
app.delete('/api/events/:id', authenticateAdmin, async (req, res) => {
  try {
    const submissionCount = await Submission.countDocuments({ eventId: req.params.id });
    
    if (submissionCount > 0) {
      return res.status(400).json({ 
        error: `Cannot delete event with ${submissionCount} submission(s). Archive it instead.` 
      });
    }
    
    const event = await Event.findByIdAndDelete(req.params.id);
    
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    res.json({ message: 'Event deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Upload logo for event branding (admin only)
app.post('/api/events/:id/branding/logo', authenticateAdmin, async (req, res) => {
  try {
    const { logo } = req.body; // Base64 image
    
    if (!logo) {
      return res.status(400).json({ error: 'Logo image is required' });
    }
    
    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    // Delete old logo if exists
    if (event.brandingSettings?.logoUrl) {
      try {
        await deleteImageFromS3(event.brandingSettings.logoUrl);
      } catch (err) {
        console.warn('Failed to delete old logo:', err.message);
      }
    }
    
    // Upload new logo to S3
    console.log('Uploading logo to S3...');
    const logoUrl = await uploadImageToS3(logo, 'branding');
    console.log(`Logo uploaded: ${logoUrl}`);
    
    // Initialize brandingSettings if not exists
    if (!event.brandingSettings) {
      event.brandingSettings = {};
    }
    
    event.brandingSettings.logoUrl = logoUrl;
    event.updatedAt = new Date();
    await event.save();
    
    res.json({ 
      message: 'Logo uploaded successfully',
      logoUrl: logoUrl
    });
  } catch (error) {
    console.error('Logo upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update branding settings for event (admin only)
app.put('/api/events/:id/branding', authenticateAdmin, async (req, res) => {
  try {
    const { enabled, position, size, opacity } = req.body;
    
    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    // Initialize brandingSettings if not exists
    if (!event.brandingSettings) {
      event.brandingSettings = {};
    }
    
    // Update settings
    if (enabled !== undefined) event.brandingSettings.enabled = enabled;
    if (position) {
      event.brandingSettings.position = {
        x: position.x !== undefined ? position.x : event.brandingSettings.position?.x || 50,
        y: position.y !== undefined ? position.y : event.brandingSettings.position?.y || 10
      };
    }
    if (size) {
      event.brandingSettings.size = {
        width: size.width !== undefined ? size.width : event.brandingSettings.size?.width || 20,
        maintainAspectRatio: size.maintainAspectRatio !== undefined ? size.maintainAspectRatio : event.brandingSettings.size?.maintainAspectRatio !== false
      };
    }
    if (opacity !== undefined) event.brandingSettings.opacity = opacity;
    
    event.updatedAt = new Date();
    await event.save();
    
    console.log('✅ Branding settings saved:', {
      eventId: event._id,
      enabled: event.brandingSettings.enabled,
      logoUrl: event.brandingSettings.logoUrl,
      position: event.brandingSettings.position,
      size: event.brandingSettings.size,
      opacity: event.brandingSettings.opacity
    });
    
    res.json({ 
      message: 'Branding settings updated successfully',
      brandingSettings: event.brandingSettings
    });
  } catch (error) {
    console.error('Branding settings update error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete logo from event branding (admin only)
app.delete('/api/events/:id/branding/logo', authenticateAdmin, async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    // Delete logo from S3 if exists
    if (event.brandingSettings?.logoUrl) {
      try {
        await deleteImageFromS3(event.brandingSettings.logoUrl);
      } catch (err) {
        console.warn('Failed to delete logo from S3:', err.message);
      }
      
      event.brandingSettings.logoUrl = '';
      event.brandingSettings.enabled = false;
      event.updatedAt = new Date();
      await event.save();
    }
    
    res.json({ message: 'Logo deleted successfully' });
  } catch (error) {
    console.error('Logo deletion error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===== LEGACY CAPTURE SETTINGS ROUTES (for backward compatibility) =====
// These will redirect to event-based settings in the future

// Get capture settings - now requires eventId
app.get('/api/capture-settings', async (req, res) => {
  try {
    const { eventId } = req.query;
    
    if (eventId) {
      // New way: get from event
      const event = await Event.findById(eventId);
      if (!event) {
        return res.status(404).json({ error: 'Event not found' });
      }
      return res.json(event.captureSettings || {
        promptMode: 'free',
        customTextMode: 'free'
      });
    }
    
    // Legacy: return default settings
    res.json({
      promptMode: 'free',
      lockedPromptTitle: '',
      lockedPromptValue: '',
      promptPresets: [],
      customTextMode: 'free',
      lockedCustomTextValue: '',
      customTextPresets: []
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== PUBLIC GALLERY ENDPOINT =====

// Get submission for public gallery (no auth required)
app.get('/api/gallery/:id', async (req, res) => {
  try {
    const submission = await Submission.findById(req.params.id)
      .populate('eventId', 'name');
    
    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    // Only return necessary public data
    res.json({
      name: submission.name,
      eventName: submission.eventId?.name || null,
      generatedImages: submission.generatedImages || [],
      status: submission.status,
      processedAt: submission.processedAt
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Serve static frontend files (after API routes)
app.use(express.static(path.join(__dirname, '../frontend')));

// Root route
// Processor heartbeat tracking
let lastProcessorHeartbeat = null;

// Processor heartbeat endpoint
app.post('/api/processor/heartbeat', authenticateProcessor, (req, res) => {
  lastProcessorHeartbeat = new Date();
  res.json({ success: true, timestamp: lastProcessorHeartbeat });
});

// Check processor status
app.get('/api/processor/status', authenticateAdmin, (req, res) => {
  const now = new Date();
  const isHealthy = lastProcessorHeartbeat && (now - lastProcessorHeartbeat) < 60000; // 60 seconds
  
  res.json({
    isHealthy,
    lastHeartbeat: lastProcessorHeartbeat,
    timeSinceLastHeartbeat: lastProcessorHeartbeat ? now - lastProcessorHeartbeat : null
  });
});

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

