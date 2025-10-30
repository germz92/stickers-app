require('dotenv').config(); // Load environment variables FIRST

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
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
    enum: ['pending', 'approved', 'processing', 'completed', 'rejected'],
    default: 'pending'
  },
  generatedImages: [{
    url: String, // S3 URL
    filename: String,
    createdAt: { type: Date, default: Date.now }
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

// Update submission details (admin page)
app.patch('/api/submissions/:id', authenticateAdmin, async (req, res) => {
  try {
    const { photo, prompt, customText } = req.body;
    
    const updateData = {};
    if (photo !== undefined) updateData.photo = photo;
    if (prompt !== undefined) updateData.prompt = prompt;
    if (customText !== undefined) updateData.customText = customText;

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
    
    if (!['pending', 'approved', 'processing', 'completed', 'rejected'].includes(status)) {
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

// Get approved submissions for processing (local processor)
app.get('/api/submissions/approved/queue', async (req, res) => {
  try {
    const { processorSecret } = req.query;
    
    if (processorSecret !== process.env.PROCESSOR_SECRET) {
      return res.status(401).json({ error: 'Invalid processor secret' });
    }

    const submissions = await Submission.find({ status: 'approved' })
      .sort({ createdAt: 1 })
      .limit(10);
    
    res.json(submissions);
  } catch (error) {
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

