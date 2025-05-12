const express = require('express');
const mongoose = require('mongoose');
const OpenAI = require('openai');
const paypal = require('@paypal/checkout-server-sdk');
const CryptoJS = require('crypto-js');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// MongoDB Verbindung
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB verbunden'))
  .catch(err => console.error(err));

// Schemas
const KeySchema = new mongoose.Schema({
  userId: String,
  openaiKey: String, // Verschlüsselt
  paypalClientId: String, // Verschlüsselt
  paypalSecret: String, // Verschlüsselt
});
const CaseSchema = new mongoose.Schema({
  userId: String,
  type: String, // 'chat', 'image', 'payment'
  details: Object,
  timestamp: { type: Date, default: Date.now },
});

const Key = mongoose.model('Key', KeySchema);
const Case = mongoose.model('Case', CaseSchema);

// Verschlüsselung
const encrypt = (text) => CryptoJS.AES.encrypt(text, process.env.SECRET_KEY).toString();
const decrypt = (ciphertext) => {
  const bytes = CryptoJS.AES.decrypt(ciphertext, process.env.SECRET_KEY);
  return bytes.toString(CryptoJS.enc.Utf8);
};

// Routen
app.post('/keys', async (req, res) => {
  const { userId, openaiKey, paypalClientId, paypalSecret } = req.body;
  try {
    const encryptedKeys = {
      openaiKey: encrypt(openaiKey),
      paypalClientId: encrypt(paypalClientId),
      paypalSecret: encrypt(paypalSecret),
    };
    await Key.findOneAndUpdate(
      { userId },
      { ...encryptedKeys, userId },
      { upsert: true }
    );
    await Case.create({ userId, type: 'key_update', details: { message: 'Schlüssel aktualisiert' } });
    res.json({ message: 'Schlüssel gespeichert' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/chat', async (req, res) => {
  const { userId, prompt } = req.body;
  try {
    const keyData = await Key.findOne({ userId });
    if (!keyData) return res.status(400).json({ error: 'Keine Schlüssel gefunden' });

    const userOpenAI = new OpenAI({ apiKey: decrypt(keyData.openaiKey) });
    const response = await userOpenAI.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: prompt }],
    });

    await Case.create({
      userId,
      type: 'chat',
      details: { prompt, response: response.choices[0].message.content },
    });

    res.json({ response: response.choices[0].message.content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/image', async (req, res) => {
  const { userId, prompt } = req.body;
  try {
    const keyData = await Key.findOne({ userId });
    if (!keyData) return res.status(400).json({ error: 'Keine Schlüssel gefunden' });

    const userOpenAI = new OpenAI({ apiKey: decrypt(keyData.openaiKey) });
    const response = await userOpenAI.images.generate({
      model: 'dall-e-3',
      prompt,
      n: 1,
      size: '1024x1024',
    });

    await Case.create({
      userId,
      type: 'image',
      details: { prompt, imageUrl: response.data[0].url },
    });

    res.json({ imageUrl: response.data[0].url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/paypal', async (req, res) => {
  const { userId, amount } = req.body;
  try {
    const keyData = await Key.findOne({ userId });
    if (!keyData) return res.status(400).json({ error: 'Keine Schlüssel gefunden' });

    const paypalClient = new paypal.core.PayPalHttpClient(
      new paypal.core.SandboxEnvironment(
        decrypt(keyData.paypalClientId),
        decrypt(keyData.paypalSecret)
      )
    );
    const request = new paypal.orders.OrdersCreateRequest();
    request.requestBody({
      intent: 'CAPTURE',
      purchase_units: [{ amount: { currency_code: 'USD', value: amount } }],
    });

    const response = await paypalClient.execute(request);
    await Case.create({
      userId,
      type: 'payment',
      details: { orderId: response.result.id, amount },
    });

    res.json({ orderId: response.result.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/cases', async (req, res) => {
  const { userId } = req.query;
  try {
    const cases = await Case.find({ userId }).sort({ timestamp: -1 });
    res.json(cases);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`));
