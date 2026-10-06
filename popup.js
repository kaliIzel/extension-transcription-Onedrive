let datosGuardados = null;

// Cargar API Key
document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get(['geminiApiKey'], (result) => {
    if (result.geminiApiKey) {
      document.getElementById('txtApiKey').value = result.geminiApiKey;
    }
  });
});

// Guardar API Key
document.getElementById('btnGuardarKey').addEventListener('click', () => {
  const key = document.getElementById('txtApiKey').value.trim();
  if (key) {
    chrome.storage.local.set({ geminiApiKey: key }, () => {
      alert("API Key guardada correctamente.");
    });
  } else {
    alert("Por favor ingresa una clave válida.");
  }
});

// 1. Obtener Transcripción
document.getElementById('btnExtraer').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  
  chrome.tabs.sendMessage(tab.id, { action: "EXTRAER_DATOS" }, (response) => {
    const areaTexto = document.getElementById('resultado');
    const metaBox = document.getElementById('metaBox');
    const btnPdf = document.getElementById('btnPdf');
    const btnResumir = document.getElementById('btnResumir');

    if (chrome.runtime.lastError) {
      areaTexto.value = "Error: Recarga la página de SharePoint (F5) e intenta de nuevo.";
      return;
    }

    if (response && response.exito) {
      datosGuardados = response;
      areaTexto.value = response.transcripcion;
      
      document.getElementById('lblTitulo').innerText = response.metadatos.titulo;
      document.getElementById('lblFecha').innerText = response.metadatos.fecha;
      document.getElementById('lblHora').innerText = response.metadatos.hora;
      
      metaBox.style.display = "block";
      btnResumir.style.display = "block";
      btnPdf.style.display = "block";
    } else {
      areaTexto.value = response ? response.error : "No se pudo leer la página.";
    }
  });
});

// 2. Generar Resumen con Gemini
document.getElementById('btnResumir').addEventListener('click', async () => {
  const apiKey = document.getElementById('txtApiKey').value.trim();
  if (!apiKey) {
    alert("Ingresa y guarda tu API Key de Gemini primero.");
    return;
  }

  if (!datosGuardados || !datosGuardados.transcripcion) {
    alert("Primero debes obtener la transcripción.");
    return;
  }

  const btnResumir = document.getElementById('btnResumir');
  const txtResumen = document.getElementById('txtResumen');
  const seccionResumen = document.getElementById('seccionResumen');

  btnResumir.innerText = "Procesando con Gemini IA...";
  btnResumir.disabled = true;
  seccionResumen.style.display = "block";
  txtResumen.value = "Conectando con Gemini...";

  try {
    // Recortamos el texto para asegurar respuesta rápida sin sobrepasar el límite de payload
    const textoSegmentado = datosGuardados.transcripcion.slice(0, 20000);

    const prompt = `Analiza la siguiente transcripción de una clase universitaria y genera un resumen en español:
1. Resumen Ejecutivo (3-4 oraciones).
2. Temas Principales Explicados.
3. Tareas o Avisos del Docente.

Transcripción:
${textoSegmentado}`;

    const response = await fetch(`https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });

    const data = await response.json();

    if (response.ok && data.candidates && data.candidates[0]?.content?.parts[0]?.text) {
      const resumenTexto = data.candidates[0].content.parts[0].text;
      txtResumen.value = resumenTexto;
      datosGuardados.resumen = resumenTexto;
    } else if (data.error) {
      txtResumen.value = `Error de API (${data.error.code}): ${data.error.message}`;
    } else {
      txtResumen.value = "Respuesta no válida de la API de Gemini.";
    }
  } catch (error) {
    txtResumen.value = "Error de conexión: " + error.message;
  } finally {
    btnResumir.innerText = "2. Generar Resumen con Gemini IA";
    btnResumir.disabled = false;
  }
});

// 3. Descargar PDF
document.getElementById('btnPdf').addEventListener('click', () => {
  if (!datosGuardados) return;

  const { metadatos, transcripcion, resumen } = datosGuardados;

  const ventanaImpresion = window.open('', '_blank');
  
  ventanaImpresion.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>${metadatos.titulo} - Resumen & Transcripción</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 20px; color: #333; line-height: 1.6; }
        .header { border-bottom: 2px solid #0078d4; padding-bottom: 10px; margin-bottom: 15px; }
        h1 { color: #0078d4; margin: 0 0 5px 0; font-size: 20px; }
        .meta-box { background: #f3f2f1; padding: 12px; border-left: 4px solid #0078d4; margin-bottom: 20px; font-size: 13px; }
        .meta-box p { margin: 3px 0; }
        .resumen-box { background: #f3e8ff; border: 1px solid #c084fc; padding: 15px; border-radius: 6px; margin-bottom: 20px; font-size: 12px; white-space: pre-wrap; }
        .content { white-space: pre-wrap; font-family: Consolas, monospace; font-size: 10px; background: #fff; border: 1px solid #ccc; padding: 15px; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>Reporte de Clase Virtual</h1>
      </div>
      <div class="meta-box">
        <p><strong>Clase / Archivo:</strong> ${metadatos.titulo}</p>
        <p><strong>Fecha de Grabación:</strong> ${metadatos.fecha}</p>
        <p><strong>Hora de Inicio:</strong> ${metadatos.hora}</p>
      </div>

      ${resumen ? `
        <h3 style="color: #6b21a8;">Resumen Generado por Gemini IA</h3>
        <div class="resumen-box">${resumen}</div>
      ` : ''}

      <h3>Transcripción Completa</h3>
      <div class="content">${transcripcion}</div>
      
      <script>
        window.onload = function() { window.print(); };
      </script>
    </body>
    </html>
  `);

  ventanaImpresion.document.close();
});