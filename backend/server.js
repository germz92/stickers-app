require('dotenv').config(); // Load environment variables FIRST

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const { uploadImageToS3, uploadBufferToS3, deleteImageFromS3, uploadMultipleImagesToS3 } = require('./s3');
const crypto = require('crypto');
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
  autoApprove: { type: Boolean, default: false }, // Auto-approve pending submissions
  badgeMode: { type: Boolean, default: false }, // Badge Mode: badge fields + badge-insert download

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
    customTextDisabled: { type: Boolean, default: false }, // NEW: Disable custom text completely
    lockedCustomTextValue: { type: String, default: '' },
    customTextPresets: [{
      name: String,
      value: String
    }]
  },

  // Per-event download / print output settings
  generationSettings: {
    showNameOnDownload: { type: Boolean, default: true },
    nameLabelPosition: {
      type: String,
      enum: ['topLeft', 'topCenter', 'topRight', 'bottomLeft', 'bottomRight'],
      default: 'bottomLeft'
    },
    downloadFilenameMode: {
      type: String,
      enum: ['attendeeName', 'customName'],
      default: 'attendeeName'
    },
    customDownloadFilename: { type: String, default: '' }
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
  firstName: { type: String, default: '' }, // Badge Mode
  lastName: { type: String, default: '' },   // Badge Mode
  jobTitle: { type: String, default: '' },   // Badge Mode
  company: { type: String, default: '' },    // Badge Mode
  email: { type: String, default: '' },
  phone: { type: String, default: '' },
  photo: { type: String, required: true }, // S3 URL
  photoThumb: { type: String, default: '' }, // Small JPEG for admin queue
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
  let token = authHeader ? authHeader.split(' ')[1] : null;
  if (!token && req.query.token) {
    token = req.query.token;
  }
  if (!token) {
    return res.status(401).json({ error: 'No authorization token' });
  }

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
    const { eventId, name, firstName, lastName, jobTitle, company, email, phone, photo, prompt, customText } = req.body;

    if (!eventId || !photo || !prompt) {
      return res.status(400).json({ error: 'Event, photo, and prompt are required' });
    }

    // Verify event exists and is not archived
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    if (event.isArchived) {
      return res.status(400).json({ error: 'Cannot submit to archived event' });
    }

    // In badge mode the display name is derived from first/last name; otherwise use the single name field
    const resolvedName = event.badgeMode
      ? `${(firstName || '').trim()} ${(lastName || '').trim()}`.trim()
      : (name || '').trim();

    if (event.badgeMode) {
      if (!(firstName || '').trim() || !(lastName || '').trim() || !(jobTitle || '').trim() || !(company || '').trim()) {
        return res.status(400).json({ error: 'First name, last name, job title, and company are required' });
      }
    } else if (!resolvedName) {
      return res.status(400).json({ error: 'Name is required' });
    }

    // Upload photo to S3
    console.log('Uploading photo to S3...');
    const photoUrl = await uploadImageToS3(photo, 'submissions');
    console.log(`Photo uploaded: ${photoUrl}`);

    let photoThumb = '';
    try {
      photoThumb = await createPhotoThumbnailFromBase64(photo);
    } catch (thumbErr) {
      console.warn('Thumbnail generation failed:', thumbErr.message);
    }

    const submission = new Submission({
      eventId,
      name: resolvedName,
      firstName: event.badgeMode ? (firstName || '').trim() : '',
      lastName: event.badgeMode ? (lastName || '').trim() : '',
      jobTitle: event.badgeMode ? (jobTitle || '').trim() : '',
      company: event.badgeMode ? (company || '').trim() : '',
      email: email || '',
      phone: phone || '',
      photo: photoUrl, // Store S3 URL instead of base64
      photoThumb,
      prompt,
      customText: event.badgeMode ? '' : (customText || ''),
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

// Admin Generate tab: create submission already queued for processor (front of line)
app.post('/api/submissions/admin-upload', authenticateAdmin, async (req, res) => {
  try {
    const { eventId, name, firstName, lastName, jobTitle, company, photo, prompt, customText } = req.body;

    if (!eventId || !photo || !prompt) {
      return res.status(400).json({ error: 'Event, photo, and prompt are required' });
    }

    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    if (event.isArchived) {
      return res.status(400).json({ error: 'Cannot submit to archived event' });
    }

    const badgeMode = event.badgeMode === true;
    if (badgeMode) {
      if (!(firstName || '').trim() || !(lastName || '').trim() || !(jobTitle || '').trim() || !(company || '').trim()) {
        return res.status(400).json({ error: 'First name, last name, job title, and company are required' });
      }
    }
    const resolvedName = badgeMode
      ? (`${(firstName || '').trim()} ${(lastName || '').trim()}`.trim() || name || 'Admin Upload')
      : (name || 'Admin Upload');

    const photoUrl = await uploadImageToS3(photo, 'submissions');
    let photoThumb = '';
    try {
      photoThumb = await createPhotoThumbnailFromBase64(photo);
    } catch (thumbErr) {
      console.warn('Thumbnail generation failed:', thumbErr.message);
    }

    const submission = new Submission({
      eventId,
      name: resolvedName,
      firstName: badgeMode ? (firstName || '').trim() : '',
      lastName: badgeMode ? (lastName || '').trim() : '',
      jobTitle: badgeMode ? (jobTitle || '').trim() : '',
      company: badgeMode ? (company || '').trim() : '',
      email: '',
      phone: '',
      photo: photoUrl,
      photoThumb,
      prompt,
      customText: badgeMode ? '' : (customText || ''),
      status: 'approved',
      approvedAt: new Date(0),
      retryCount: 0,
      generatedImages: []
    });

    await submission.save();

    res.status(201).json({
      message: 'Submission queued for generation',
      submissionId: submission._id,
      submission
    });
  } catch (error) {
    console.error('Admin upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all submissions (admin page) - now requires eventId
app.get('/api/submissions', authenticateAdmin, async (req, res) => {
  try {
    const { eventId, status, limit, skip, search } = req.query;
    
    // Build query
    const query = {};
    if (eventId) {
      query.eventId = eventId;
    }
    if (status) {
      query.status = status;
    }
    if (search && String(search).trim()) {
      const escaped = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(escaped, 'i');
      query.$or = [
        { name: pattern },
        { email: pattern },
        { phone: pattern }
      ];
    }
    
    // Pagination parameters
    const limitNum = parseInt(limit) || 50; // Default 50 per page
    const skipNum = parseInt(skip) || 0;
    
    // Get total count for pagination info
    const total = await Submission.countDocuments(query);
    
    const sortOption = status === 'completed'
      ? { processedAt: -1, createdAt: -1 }
      : { createdAt: -1 };

    const submissions = await Submission.find(query)
      .select('-processingLogs')
      .populate('eventId', 'name')
      .sort(sortOption)
      .limit(limitNum)
      .skip(skipNum);
    
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
    const batchLimit = parseInt(process.env.APPROVED_QUEUE_BATCH, 10) || 10;
    const submissions = await Submission.find({ status: 'approved' })
      .sort({ approvedAt: 1, retryCount: 1 })
      .limit(batchLimit);
    
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

// Get submission thumbnail (legacy JSON — prefer /photo/thumb image endpoint)
app.get('/api/submissions/:id/thumbnail', authenticateAdmin, async (req, res) => {
  try {
    const submission = await Submission.findById(req.params.id).select('photo photoThumb name');
    
    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }
    
    res.json({
      photo: submission.photoThumb || submission.photo,
      name: submission.name
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const QUEUE_THUMB_SIZE = 200;

async function fetchImageBuffer(url) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 20000,
    maxContentLength: 25 * 1024 * 1024
  });
  return Buffer.from(response.data);
}

async function bufferToQueueThumb(buffer) {
  return sharp(buffer)
    .rotate()
    .resize(QUEUE_THUMB_SIZE, QUEUE_THUMB_SIZE, { fit: 'cover' })
    .jpeg({ quality: 78, mozjpeg: true })
    .toBuffer();
}

async function createPhotoThumbnailFromBase64(base64Data) {
  const base64Image = base64Data.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(base64Image, 'base64');
  const thumbBuffer = await bufferToQueueThumb(buffer);
  const key = `submissions/thumbs/${Date.now()}-${crypto.randomBytes(8).toString('hex')}.jpg`;
  return uploadBufferToS3(thumbBuffer, key, 'image/jpeg');
}

async function createPhotoThumbnailFromUrl(imageUrl) {
  const buffer = await fetchImageBuffer(imageUrl);
  const thumbBuffer = await bufferToQueueThumb(buffer);
  const key = `submissions/thumbs/${Date.now()}-${crypto.randomBytes(8).toString('hex')}.jpg`;
  return uploadBufferToS3(thumbBuffer, key, 'image/jpeg');
}

function schedulePhotoThumbBackfill(submissionId, photoUrl) {
  createPhotoThumbnailFromUrl(photoUrl)
    .then((photoThumb) => Submission.findByIdAndUpdate(submissionId, { photoThumb }))
    .catch((err) => console.warn(`Thumb backfill failed for ${submissionId}:`, err.message));
}

// Queue-sized attendee photo (JPEG ~200px)
app.get('/api/submissions/:id/photo/thumb', authenticateAdmin, async (req, res) => {
  try {
    const submission = await Submission.findById(req.params.id).select('photo photoThumb');
    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }
    if (submission.photoThumb) {
      res.set('Cache-Control', 'public, max-age=86400');
      return res.redirect(302, submission.photoThumb);
    }
    if (!submission.photo) {
      return res.status(404).json({ error: 'No photo' });
    }
    const thumbBuffer = await bufferToQueueThumb(await fetchImageBuffer(submission.photo));
    schedulePhotoThumbBackfill(submission._id, submission.photo);
    res.set('Cache-Control', 'public, max-age=3600');
    res.type('jpeg');
    res.send(thumbBuffer);
  } catch (error) {
    console.error('Photo thumb error:', error.message);
    res.status(500).json({ error: 'Failed to generate thumbnail' });
  }
});

// Queue-sized generated sticker preview
app.get('/api/submissions/:id/sticker-thumb/:index', authenticateAdmin, async (req, res) => {
  try {
    const index = parseInt(req.params.index, 10);
    if (Number.isNaN(index) || index < 0) {
      return res.status(400).json({ error: 'Invalid index' });
    }
    const submission = await Submission.findById(req.params.id).select('generatedImages');
    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }
    const image = submission.generatedImages?.[index];
    if (!image?.url) {
      return res.status(404).json({ error: 'Sticker not found' });
    }
    const thumbBuffer = await bufferToQueueThumb(await fetchImageBuffer(image.url));
    const etag = crypto.createHash('md5').update(image.url).digest('hex');
    res.set('ETag', `"${etag}"`);
    res.set('Cache-Control', 'private, max-age=3600, must-revalidate');
    res.type('jpeg');
    res.send(thumbBuffer);
  } catch (error) {
    console.error('Sticker thumb error:', error.message);
    res.status(500).json({ error: 'Failed to generate thumbnail' });
  }
});

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sanitizeDownloadFilename(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return '';

  const safe = trimmed
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  return safe || '';
}

const VALID_NAME_LABEL_POSITIONS = ['topLeft', 'topCenter', 'topRight', 'bottomLeft', 'bottomRight'];

function normalizeNameLabelPosition(position) {
  return VALID_NAME_LABEL_POSITIONS.includes(position) ? position : 'bottomLeft';
}

function getDefaultGenerationSettings() {
  return {
    showNameOnDownload: true,
    nameLabelPosition: 'bottomLeft',
    downloadFilenameMode: 'attendeeName',
    customDownloadFilename: ''
  };
}

function buildDownloadFilename(nameForFile, imageNumber) {
  const safeName = sanitizeDownloadFilename(nameForFile);
  if (safeName) {
    return `${safeName}-${imageNumber}.png`;
  }
  return `sticker-${imageNumber}.png`;
}

// PTCreate Pro / Primera LX610 expect ~300 DPI; 600 DPI pHYs is often ignored and
// imports size to the tight content box instead of the full page. Override via PRINT_DPI in .env.
const PRINT_DPI = Number(process.env.PRINT_DPI) || 300;
const PRINT_WIDTH = Math.round(4 * PRINT_DPI);
const PRINT_HEIGHT = Math.round(3 * PRINT_DPI);
const LABEL_MARGIN = Math.max(8, Math.round(PRINT_DPI * 0.02));
const LABEL_BAND_HEIGHT = Math.round(PRINT_HEIGHT * (140 / 1800));
const REGISTRATION_MARK_PX = 8; // corner squares so RIP sees full 4×3 bounds (not 1px dots)

// Badge Mode: white insert that drops into the badge's 3.9" x 4" empty area
const BADGE_INSERT_WIDTH = Math.round(3.9 * PRINT_DPI); // 1170 @ 300 DPI
const BADGE_INSERT_HEIGHT = Math.round(4 * PRINT_DPI);  // 1200 @ 300 DPI
const BADGE_ACCENT_COLOR = '#E2231A'; // red accent (job title + rule), matches sample badge

async function cleanStickerAlpha(imageBuffer) {
  const { data, info } = await sharp(imageBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;

  for (let i = 0; i < width * height; i++) {
    const alphaIdx = i * 4 + 3;
    data[alphaIdx] = data[alphaIdx] > 240 ? 255 : 0;
  }

  const isExterior = new Uint8Array(width * height);
  const queue = [];

  for (let x = 0; x < width; x++) {
    if (data[x * 4 + 3] === 0) {
      queue.push(x);
      isExterior[x] = 1;
    }
    const bottomIdx = (height - 1) * width + x;
    if (data[bottomIdx * 4 + 3] === 0) {
      queue.push(bottomIdx);
      isExterior[bottomIdx] = 1;
    }
  }
  for (let y = 0; y < height; y++) {
    const leftIdx = y * width;
    if (data[leftIdx * 4 + 3] === 0) {
      queue.push(leftIdx);
      isExterior[leftIdx] = 1;
    }
    const rightIdx = y * width + (width - 1);
    if (data[rightIdx * 4 + 3] === 0) {
      queue.push(rightIdx);
      isExterior[rightIdx] = 1;
    }
  }

  while (queue.length > 0) {
    const idx = queue.shift();
    const x = idx % width;
    const y = Math.floor(idx / width);
    const neighbors = [
      { nx: x - 1, ny: y },
      { nx: x + 1, ny: y },
      { nx: x, ny: y - 1 },
      { nx: x, ny: y + 1 }
    ];
    for (const { nx, ny } of neighbors) {
      if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
        const nIdx = ny * width + nx;
        if (data[nIdx * 4 + 3] === 0 && isExterior[nIdx] === 0) {
          isExterior[nIdx] = 1;
          queue.push(nIdx);
        }
      }
    }
  }

  for (let i = 0; i < width * height; i++) {
    if (data[i * 4 + 3] === 0 && isExterior[i] === 0) {
      data[i * 4 + 3] = 255;
    }
  }

  return sharp(data, {
    raw: { width, height, channels: 4 }
  }).png().toBuffer();
}

function getOpaqueBoundsFromBuffer(data, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 0) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (maxX < 0) return null;

  return {
    minX,
    minY,
    maxX,
    maxY,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2
  };
}

async function getOpaqueBounds(imageBuffer) {
  const { data, info } = await sharp(imageBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return getOpaqueBoundsFromBuffer(data, info.width, info.height);
}

async function compositeToPrintCanvas(imageBuffer, { labelPosition = null } = {}) {
  const cleaned = await cleanStickerAlpha(imageBuffer);
  const position = labelPosition ? normalizeNameLabelPosition(labelPosition) : null;
  const reserveBand = Boolean(position);
  const labelOnTop = position === 'topLeft' || position === 'topCenter' || position === 'topRight';
  const artHeight = reserveBand ? PRINT_HEIGHT - LABEL_BAND_HEIGHT : PRINT_HEIGHT;

  const resized = await sharp(cleaned)
    .resize(PRINT_WIDTH, artHeight, { fit: 'inside', kernel: 'lanczos3' })
    .toBuffer();
  const stickerMeta = await sharp(resized).metadata();
  const bounds = await getOpaqueBounds(resized);

  // Center the visible sticker art (opaque pixels), not the square image bounding box.
  let left;
  let top;
  if (bounds) {
    left = Math.round(PRINT_WIDTH / 2 - bounds.cx);
    top = Math.round(artHeight / 2 - bounds.cy);
  } else {
    left = Math.round((PRINT_WIDTH - stickerMeta.width) / 2);
    top = Math.round((artHeight - stickerMeta.height) / 2);
  }

  left = Math.max(0, Math.min(left, PRINT_WIDTH - stickerMeta.width));
  top = Math.max(0, Math.min(top, artHeight - stickerMeta.height));
  if (labelOnTop) {
    top += LABEL_BAND_HEIGHT;
  }

  return sharp({
    create: {
      width: PRINT_WIDTH,
      height: PRINT_HEIGHT,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite([{ input: resized, left, top }])
    .png()
    .toBuffer();
}

async function finalizePrintPng(imageBuffer) {
  const { data, info } = await sharp(imageBuffer)
    .resize(PRINT_WIDTH, PRINT_HEIGHT, { fit: 'fill', kernel: 'lanczos3' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Pin document bounds to the full 4×3 sheet (PTCreate Pro uses content bounding box).
  const mark = REGISTRATION_MARK_PX;
  for (let dy = 0; dy < mark; dy++) {
    for (let dx = 0; dx < mark; dx++) {
      const corners = [
        [dx, dy],
        [info.width - mark + dx, dy],
        [dx, info.height - mark + dy],
        [info.width - mark + dx, info.height - mark + dy]
      ];
      for (const [x, y] of corners) {
        const px = y * info.width + x;
        data[px * 4] = 255;
        data[px * 4 + 1] = 255;
        data[px * 4 + 2] = 255;
        data[px * 4 + 3] = 255;
      }
    }
  }

  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 }
  })
    .withMetadata({ density: PRINT_DPI })
    .png({
      compressionLevel: 9,
      quality: 90,
      density: PRINT_DPI,
      force: true
    })
    .toBuffer();
}

function computeNameLabelPlacement(position, width, height, boxWidth, boxHeight) {
  const pos = normalizeNameLabelPosition(position);
  const bandTop = height - LABEL_BAND_HEIGHT;
  const bandBottom = LABEL_BAND_HEIGHT;

  let boxX = LABEL_MARGIN;
  let boxY = height - LABEL_MARGIN - boxHeight;

  if (pos === 'topLeft') {
    boxX = LABEL_MARGIN;
    boxY = LABEL_MARGIN;
    boxY = Math.min(boxY, bandBottom - boxHeight - 8);
  } else if (pos === 'topCenter') {
    boxX = Math.round((width - boxWidth) / 2);
    boxY = LABEL_MARGIN;
    boxY = Math.min(boxY, bandBottom - boxHeight - 8);
  } else if (pos === 'topRight') {
    boxX = width - LABEL_MARGIN - boxWidth;
    boxY = LABEL_MARGIN;
    boxY = Math.min(boxY, bandBottom - boxHeight - 8);
  } else if (pos === 'bottomRight') {
    boxX = width - LABEL_MARGIN - boxWidth;
    boxY = Math.max(bandTop + 8, height - LABEL_MARGIN - boxHeight);
  } else {
    // bottomLeft
    boxX = LABEL_MARGIN;
    boxY = Math.max(bandTop + 8, height - LABEL_MARGIN - boxHeight);
  }

  return { boxX, boxY };
}

// Solid textbox label (no letter stroke) so cutters ignore letter shapes
async function applyAttendeeNameLabel(imageBuffer, name, position = 'bottomLeft') {
  const trimmed = (name || '').trim();
  if (!trimmed) return imageBuffer;

  const metadata = await sharp(imageBuffer).metadata();
  const width = metadata.width;
  const height = metadata.height;
  const fontSize = Math.max(18, Math.round(height * 0.026));
  const padX = Math.round(fontSize * 0.55);
  const padY = Math.round(fontSize * 0.4);
  const label = escapeXml(trimmed);

  const textWidth = Math.ceil(trimmed.length * fontSize * 0.52);
  const boxWidth = textWidth + padX * 2;
  const boxHeight = fontSize + padY * 2;
  const { boxX, boxY } = computeNameLabelPlacement(position, width, height, boxWidth, boxHeight);
  const textX = boxX + padX;
  const textY = boxY + padY + fontSize * 0.88;
  const radius = Math.round(fontSize * 0.2);

  const svg = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect
        x="${boxX}"
        y="${boxY}"
        width="${boxWidth}"
        height="${boxHeight}"
        rx="${radius}"
        ry="${radius}"
        fill="#ffffff"
        fill-opacity="1"
      />
      <text
        x="${textX}"
        y="${textY}"
        font-family="Arial, Helvetica, sans-serif"
        font-size="${fontSize}"
        fill="#333333"
        fill-opacity="1"
      >${label}</text>
    </svg>`
  );

  return sharp(imageBuffer)
    .composite([{ input: svg, top: 0, left: 0 }])
    .png()
    .toBuffer();
}

// Badge Mode: compose the generated avatar with name/title/company text onto a
// white 3.9"x4" insert sized to drop into the badge's empty white area.
async function compositeToBadgeInsert(avatarBuffer, badge = {}) {
  const firstName = (badge.firstName || '').trim();
  const lastName = (badge.lastName || '').trim();
  const jobTitle = (badge.jobTitle || '').trim();
  const company = (badge.company || '').trim();

  const W = BADGE_INSERT_WIDTH;
  const H = BADGE_INSERT_HEIGHT;
  const pad = Math.round(W * 0.055);
  const gap = Math.round(W * 0.03);

  // Right column holds the avatar; left column holds the text block.
  const avatarColWidth = Math.round(W * 0.44);
  const avatarColX = W - pad - avatarColWidth;
  const avatarRegionHeight = H - pad * 2;
  const textColX = pad;
  const textColWidth = avatarColX - gap - pad;

  // Clean + resize the avatar to fit inside the right column.
  const cleaned = await cleanStickerAlpha(avatarBuffer);
  const resizedAvatar = await sharp(cleaned)
    .resize(avatarColWidth, avatarRegionHeight, { fit: 'inside', kernel: 'lanczos3' })
    .toBuffer();
  const avatarMeta = await sharp(resizedAvatar).metadata();
  const avatarLeft = avatarColX + Math.round((avatarColWidth - avatarMeta.width) / 2);
  const avatarTop = pad + Math.round((avatarRegionHeight - avatarMeta.height) / 2);

  // Font sizing that shrinks to fit the text column width.
  const fitFont = (text, base, factor = 0.6, min = 22) => {
    const len = Math.max(1, (text || '').length);
    const fitted = Math.floor(textColWidth / (len * factor));
    return Math.max(min, Math.min(base, fitted));
  };
  const nameLen = Math.max(firstName.length, lastName.length, 1);
  const nameFont = Math.max(44, Math.min(116, Math.floor(textColWidth / (nameLen * 0.62))));
  const jobFont = fitFont(jobTitle, 46, 0.55, 24);
  const companyFont = fitFont(company, 38, 0.5, 22);

  const lineGap = Math.round(nameFont * 0.08);
  const ruleMarginTop = Math.round(nameFont * 0.45);
  const ruleH = Math.max(4, Math.round(PRINT_DPI * 0.02));
  const ruleWidth = Math.round(textColWidth * 0.5);
  const jobMarginTop = Math.round(jobFont * 0.95);
  const companyMarginTop = Math.round(companyFont * 0.7);

  // Vertically center the whole text block within the insert.
  let blockH = nameFont + lineGap + nameFont + ruleMarginTop + ruleH;
  if (jobTitle) blockH += jobMarginTop + jobFont;
  if (company) blockH += companyMarginTop + companyFont;
  const top = Math.max(pad, Math.round((H - blockH) / 2));

  let y = top;
  const firstBaseline = y + nameFont * 0.82;
  y += nameFont + lineGap;
  const lastBaseline = y + nameFont * 0.82;
  y += nameFont + ruleMarginTop;
  const ruleTop = y;
  y += ruleH;
  let jobBaseline = null;
  if (jobTitle) {
    y += jobMarginTop;
    jobBaseline = y + jobFont * 0.82;
    y += jobFont;
  }
  let companyBaseline = null;
  if (company) {
    y += companyMarginTop;
    companyBaseline = y + companyFont * 0.82;
  }

  const textParts = [];
  if (firstName) {
    textParts.push(`<text x="${textColX}" y="${firstBaseline}" font-family="Arial, Helvetica, sans-serif" font-size="${nameFont}" font-weight="800" fill="#111111">${escapeXml(firstName)}</text>`);
  }
  if (lastName) {
    textParts.push(`<text x="${textColX}" y="${lastBaseline}" font-family="Arial, Helvetica, sans-serif" font-size="${nameFont}" font-weight="400" fill="#111111">${escapeXml(lastName)}</text>`);
  }
  textParts.push(`<rect x="${textColX}" y="${ruleTop}" width="${ruleWidth}" height="${ruleH}" fill="${BADGE_ACCENT_COLOR}" />`);
  if (jobTitle && jobBaseline !== null) {
    textParts.push(`<text x="${textColX}" y="${jobBaseline}" font-family="Arial, Helvetica, sans-serif" font-size="${jobFont}" font-weight="600" fill="${BADGE_ACCENT_COLOR}">${escapeXml(jobTitle)}</text>`);
  }
  if (company && companyBaseline !== null) {
    textParts.push(`<text x="${textColX}" y="${companyBaseline}" font-family="Arial, Helvetica, sans-serif" font-size="${companyFont}" font-weight="400" fill="#555555">${escapeXml(company)}</text>`);
  }

  const svg = Buffer.from(
    `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${textParts.join('')}</svg>`
  );

  return sharp({
    create: {
      width: W,
      height: H,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    }
  })
    .composite([
      { input: resizedAvatar, left: avatarLeft, top: avatarTop },
      { input: svg, left: 0, top: 0 }
    ])
    .withMetadata({ density: PRINT_DPI })
    .png({ compressionLevel: 9, density: PRINT_DPI, force: true })
    .toBuffer();
}

// Proxy download endpoint to bypass CORS
app.get('/api/download', authenticateAdmin, async (req, res) => {
  try {
    const { url, filename, name, eventId, submissionId } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'URL parameter is required' });
    }

    // Load the submission (for badge fields) when provided
    let submission = null;
    if (submissionId) {
      submission = await Submission.findById(submissionId)
        .select('name firstName lastName jobTitle company eventId');
    }

    // Robust fallback: if no (valid) submissionId was passed, find the submission
    // that owns this generated image by its S3 URL. This keeps badge fields working
    // even if an older/cached frontend doesn't forward submissionId.
    if (!submission && url) {
      submission = await Submission.findOne({ 'generatedImages.url': url })
        .select('name firstName lastName jobTitle company eventId');
    }

    // Resolve the event: prefer explicit eventId, else fall back to the submission's event
    const resolvedEventId = eventId || (submission && submission.eventId ? String(submission.eventId) : null);
    let event = null;
    if (resolvedEventId) {
      event = await Event.findById(resolvedEventId).select('generationSettings badgeMode');
    }

    let generationSettings = getDefaultGenerationSettings();
    if (event?.generationSettings) {
      generationSettings = {
        ...getDefaultGenerationSettings(),
        ...JSON.parse(JSON.stringify(event.generationSettings))
      };
    }

    const badgeMode = event?.badgeMode === true;
    const attendeeName = (name || (submission && submission.name) || '').trim();
    const showNameLabel = generationSettings.showNameOnDownload !== false;
    const useCustomFilename = generationSettings.downloadFilenameMode === 'customName';
    const filenameBase = useCustomFilename
      ? generationSettings.customDownloadFilename
      : attendeeName;

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
    
    const downloadFilename = buildDownloadFilename(filenameBase, imageNumber);
    
    console.log('🎨 Starting download processing...');

    let processedImage;
    if (badgeMode) {
      console.log(`🪪 Badge Mode: compositing to ${BADGE_INSERT_WIDTH}x${BADGE_INSERT_HEIGHT}px (3.9"×4" @ ${PRINT_DPI} DPI)`);
      let badgeFirstName = submission?.firstName || '';
      let badgeLastName = submission?.lastName || '';
      // Fallback for submissions created before badge fields existed
      if (!badgeFirstName && !badgeLastName && attendeeName) {
        const parts = attendeeName.split(/\s+/);
        badgeFirstName = parts.shift() || '';
        badgeLastName = parts.join(' ');
      }
      processedImage = await compositeToBadgeInsert(imageBuffer, {
        firstName: badgeFirstName,
        lastName: badgeLastName,
        jobTitle: submission?.jobTitle || '',
        company: submission?.company || ''
      });
    } else {
      console.log(`📏 Compositing to ${PRINT_WIDTH}x${PRINT_HEIGHT}px (4"×3" @ ${PRINT_DPI} DPI)`);
      const nameLabelPosition = normalizeNameLabelPosition(generationSettings.nameLabelPosition);

      processedImage = await compositeToPrintCanvas(imageBuffer, {
        labelPosition: showNameLabel && attendeeName ? nameLabelPosition : null
      });

      if (showNameLabel && attendeeName) {
        console.log(`🏷️ Adding attendee label (${nameLabelPosition}): ${attendeeName}`);
        processedImage = await applyAttendeeNameLabel(processedImage, attendeeName, nameLabelPosition);
      }

      processedImage = await finalizePrintPng(processedImage);
    }

    const outMeta = await sharp(processedImage).metadata();
    console.log(`✅ Download ready: ${outMeta.width}x${outMeta.height}px @ ${outMeta.density || PRINT_DPI} DPI`);
    
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
    const { photo, prompt, customText, processingStartedAt, resetForGeneration } = req.body;
    
    const updateData = {};
    if (photo !== undefined) updateData.photo = photo;
    if (prompt !== undefined) updateData.prompt = prompt;
    if (customText !== undefined) updateData.customText = customText;
    if (processingStartedAt !== undefined) updateData.processingStartedAt = processingStartedAt;

    // Admin manual Generate: clear prior run so Completed sort and previews stay correct
    if (resetForGeneration && req.user?.role === 'admin') {
      updateData.generatedImages = [];
      updateData.processedAt = null;
      updateData.processingStartedAt = null;
      updateData.failureReason = null;
    }

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

// Admin Generate tab: update prompts/photo and queue at front of processor line
app.post('/api/submissions/:id/queue-for-generation', authenticateAdmin, async (req, res) => {
  try {
    const { prompt, customText, photo, firstName, lastName, jobTitle, company } = req.body;
    const submission = await Submission.findById(req.params.id);

    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    const event = await Event.findById(submission.eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    if (event.isArchived) {
      return res.status(400).json({ error: 'Cannot generate for archived event' });
    }

    if (prompt !== undefined) submission.prompt = prompt;

    const badgeMode = event.badgeMode === true;
    if (badgeMode) {
      // Badge events use first/last name + job title + company; custom text never applies
      if (firstName !== undefined) submission.firstName = (firstName || '').trim();
      if (lastName !== undefined) submission.lastName = (lastName || '').trim();
      if (jobTitle !== undefined) submission.jobTitle = (jobTitle || '').trim();
      if (company !== undefined) submission.company = (company || '').trim();
      if (!submission.firstName || !submission.lastName || !submission.jobTitle || !submission.company) {
        return res.status(400).json({ error: 'First name, last name, job title, and company are required' });
      }
      submission.name = `${submission.firstName} ${submission.lastName}`.trim();
      submission.customText = '';
    } else if (customText !== undefined) {
      submission.customText = customText;
    }

    if (photo !== undefined) {
      if (typeof photo === 'string' && photo.startsWith('data:')) {
        submission.photo = await uploadImageToS3(photo, 'submissions');
        try {
          submission.photoThumb = await createPhotoThumbnailFromBase64(photo);
        } catch (thumbErr) {
          console.warn('Thumbnail generation failed:', thumbErr.message);
        }
      } else if (typeof photo === 'string' && (photo.startsWith('http://') || photo.startsWith('https://'))) {
        submission.photo = photo;
      }
    }

    submission.generatedImages = [];
    submission.processedAt = null;
    submission.processingStartedAt = null;
    submission.failureReason = undefined;
    submission.status = 'approved';
    submission.approvedAt = new Date(0);
    submission.retryCount = 0;

    await submission.save();

    console.log(`🎯 Queued for manual generation: ${submission._id} (${submission.name})`);
    res.json(submission);
  } catch (error) {
    console.error('Queue for generation error:', error);
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
      eventId: originalSubmission.eventId,
      name: originalSubmission.name,
      photo: originalSubmission.photo,
      photoThumb: originalSubmission.photoThumb || '',
      prompt: originalSubmission.prompt,
      customText: originalSubmission.customText,
      status: 'approved',
      approvedAt: new Date(0),
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
      submission.approvedAt = null;
      submission.processedAt = null;
      submission.processingStartedAt = null;
      submission.generatedImages = [];
      submission.failureReason = undefined;
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
    const { name, description, eventDate, badgeMode } = req.body;
    
    if (!name || !eventDate) {
      return res.status(400).json({ error: 'Name and event date are required' });
    }
    
    const event = new Event({
      name,
      description: description || '',
      eventDate: new Date(eventDate),
      badgeMode: badgeMode === true,
      captureSettings: {
        promptMode: 'free',
        customTextMode: 'free'
      },
      generationSettings: getDefaultGenerationSettings()
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
    const { name, description, eventDate, badgeMode, captureSettings, generationSettings } = req.body;
    
    const event = await Event.findById(req.params.id);
    
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    if (name) event.name = name;
    if (description !== undefined) event.description = description;
    if (eventDate) event.eventDate = new Date(eventDate);
    if (badgeMode !== undefined) event.badgeMode = badgeMode === true;
    
    if (captureSettings) {
      event.captureSettings = {
        promptMode: captureSettings.promptMode || 'free',
        lockedPromptTitle: captureSettings.lockedPromptTitle || '',
        lockedPromptValue: captureSettings.lockedPromptValue || '',
        promptPresets: captureSettings.promptPresets || [],
        customTextMode: captureSettings.customTextMode || 'free',
        customTextDisabled: captureSettings.customTextDisabled || false,
        lockedCustomTextValue: captureSettings.lockedCustomTextValue || '',
        customTextPresets: captureSettings.customTextPresets || []
      };
    }

    if (generationSettings) {
      event.generationSettings = {
        showNameOnDownload: generationSettings.showNameOnDownload !== false,
        nameLabelPosition: normalizeNameLabelPosition(generationSettings.nameLabelPosition),
        downloadFilenameMode: generationSettings.downloadFilenameMode === 'customName'
          ? 'customName'
          : 'attendeeName',
        customDownloadFilename: generationSettings.customDownloadFilename || ''
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

// Toggle auto-approve for event (admin only)
app.put('/api/events/:id/auto-approve', authenticateAdmin, async (req, res) => {
  try {
    const { autoApprove } = req.body;
    
    const event = await Event.findById(req.params.id);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    event.autoApprove = autoApprove;
    event.updatedAt = new Date();
    await event.save();
    
    console.log(`✅ Auto-approve ${autoApprove ? 'enabled' : 'disabled'} for event: ${event.name}`);
    
    res.json(event);
  } catch (error) {
    console.error('Auto-approve toggle error:', error);
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

