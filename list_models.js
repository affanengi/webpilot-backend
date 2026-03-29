require('dotenv').config();

async function listModels() {
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
  
  try {
    const response = await fetch(url);
    const data = await response.json();
    if (data.models) {
        data.models.forEach(m => {
           if (m.name.includes('flash')) {
              console.log(m.name, m.supportedGenerationMethods);
           }
        });
    } else {
        console.log(data);
    }
  } catch (e) {
    console.error(e);
  }
}

listModels();
