const sgMail = require('@sendgrid/mail');
const twilio = require('twilio');

// Initialize SendGrid
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

// Initialize Twilio
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

/**
 * Generate the gallery URL for a submission
 * @param {string} submissionId - The submission ID
 * @returns {string} - The full gallery URL
 */
function getGalleryUrl(submissionId) {
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  return `${baseUrl}/gallery.html?id=${submissionId}`;
}

/**
 * Send email notification with gallery link
 * @param {Object} submission - The submission object
 * @param {Object} event - The event object
 */
async function sendEmailNotification(submission, event) {
  if (!process.env.SENDGRID_API_KEY || !submission.email) {
    console.log('📧 Email notification skipped (no API key or no email address)');
    return { sent: false, reason: 'No API key or email address' };
  }

  const galleryUrl = getGalleryUrl(submission._id);
  const eventName = event?.name || 'Your Event';

  const msg = {
    to: submission.email,
    from: {
      email: process.env.SENDGRID_FROM_EMAIL,
      name: process.env.SENDGRID_FROM_NAME || 'Stickers Generator'
    },
    subject: `Your Stickers from ${eventName} are Ready!`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="margin: 0; padding: 0; background-color: #0a0a0a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
        <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
          <!-- Header -->
          <div style="text-align: center; margin-bottom: 40px;">
            <h1 style="color: #ffffff; font-size: 28px; font-weight: 300; margin: 0; letter-spacing: 2px;">
              Your Stickers Are Ready!
            </h1>
          </div>
          
          <!-- Main Content -->
          <div style="background: linear-gradient(145deg, rgba(18, 18, 18, 0.95), rgba(30, 30, 30, 0.95)); border-radius: 16px; padding: 40px; border: 1px solid rgba(0, 229, 255, 0.2);">
            <p style="color: #e0e0e0; font-size: 18px; line-height: 1.6; margin: 0 0 20px 0;">
              Hi <strong style="color: #00e5ff;">${submission.name}</strong>,
            </p>
            
            <p style="color: #e0e0e0; font-size: 16px; line-height: 1.6; margin: 0 0 30px 0;">
              Great news! Your personalized stickers from <strong style="color: #00e5ff;">${eventName}</strong> have been created and are ready for you to view and download.
            </p>
            
            <!-- CTA Button -->
            <div style="text-align: center; margin: 40px 0;">
              <a href="${galleryUrl}" 
                 style="display: inline-block; background: linear-gradient(135deg, rgba(0, 229, 255, 0.2), rgba(0, 150, 200, 0.3)); 
                        color: #00e5ff; text-decoration: none; padding: 18px 40px; border-radius: 8px; 
                        font-size: 18px; font-weight: 500; letter-spacing: 1px; text-transform: uppercase;
                        border: 2px solid rgba(0, 229, 255, 0.5);">
                View Your Stickers
              </a>
            </div>
            
            <p style="color: #888; font-size: 14px; line-height: 1.6; margin: 30px 0 0 0; text-align: center;">
              Or copy this link: <br>
              <a href="${galleryUrl}" style="color: #00e5ff; word-break: break-all;">${galleryUrl}</a>
            </p>
          </div>
          
          <!-- Footer -->
          <div style="text-align: center; margin-top: 40px;">
            <p style="color: #555; font-size: 12px; margin: 0;">
              Powered by Lumetry Media
            </p>
          </div>
        </div>
      </body>
      </html>
    `,
    text: `Hi ${submission.name},\n\nYour personalized stickers from ${eventName} are ready!\n\nView and download them here: ${galleryUrl}\n\nPowered by Lumetry Media`
  };

  try {
    await sgMail.send(msg);
    console.log(`📧 Email sent to ${submission.email}`);
    return { sent: true, to: submission.email };
  } catch (error) {
    console.error('📧 Email error:', error.message);
    return { sent: false, error: error.message };
  }
}

/**
 * Send SMS notification with gallery link
 * @param {Object} submission - The submission object
 * @param {Object} event - The event object
 */
async function sendSmsNotification(submission, event) {
  if (!twilioClient || !submission.phone) {
    console.log('📱 SMS notification skipped (no Twilio config or no phone number)');
    return { sent: false, reason: 'No Twilio config or phone number' };
  }

  // Clean and format phone number
  let phoneNumber = submission.phone.replace(/\D/g, '');
  if (phoneNumber.length === 10) {
    phoneNumber = '+1' + phoneNumber; // Assume US number
  } else if (!phoneNumber.startsWith('+')) {
    phoneNumber = '+' + phoneNumber;
  }

  const galleryUrl = getGalleryUrl(submission._id);
  const eventName = event?.name || 'your event';

  const message = `Hi ${submission.name}! Your stickers from ${eventName} are ready. View & download here: ${galleryUrl}`;

  try {
    await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phoneNumber
    });
    console.log(`📱 SMS sent to ${phoneNumber}`);
    return { sent: true, to: phoneNumber };
  } catch (error) {
    console.error('📱 SMS error:', error.message);
    return { sent: false, error: error.message };
  }
}

/**
 * Send all notifications (email + SMS) for a completed submission
 * @param {Object} submission - The submission object
 * @param {Object} event - The event object
 */
async function sendCompletionNotifications(submission, event) {
  const results = {
    email: null,
    sms: null
  };

  // Send email if address provided
  if (submission.email) {
    results.email = await sendEmailNotification(submission, event);
  }

  // Send SMS if phone provided
  if (submission.phone) {
    results.sms = await sendSmsNotification(submission, event);
  }

  return results;
}

module.exports = {
  sendEmailNotification,
  sendSmsNotification,
  sendCompletionNotifications,
  getGalleryUrl
};

