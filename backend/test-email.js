import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
dotenv.config();

console.log('Testing email credentials...');
console.log('User:', process.env.EMAIL_USER);
console.log('Pass:', process.env.EMAIL_PASS ? '********' : 'NOT SET');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

async function test() {
  try {
    const info = await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: process.env.EMAIL_USER, // Send to self
      subject: 'Test Email',
      text: 'If you get this, the credentials are correct!'
    });
    console.log('SUCCESS! Email sent:', info.response);
  } catch (err) {
    console.error('ERROR SENDING EMAIL:');
    console.error(err);
  }
}

test();
