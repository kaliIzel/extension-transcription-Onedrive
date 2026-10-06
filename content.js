chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "EXTRAER_DATOS") {
    
    // 1. Extraer Metadatos
    const tituloElemento = document.querySelector('h1, [data-automation-id="file-name"]');
    const tituloVideo = tituloElemento ? tituloElemento.innerText.trim() : document.title;
    
    let fecha = new Date().toLocaleDateString();
    let hora = new Date().toLocaleTimeString();
    
    const matchFechaHora = tituloVideo.match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
    if (matchFechaHora) {
      fecha = `${matchFechaHora[3]}/${matchFechaHora[2]}/${matchFechaHora[1]}`;
      hora = `${matchFechaHora[4]}:${matchFechaHora[5]}:${matchFechaHora[6]}`;
    }

    // 2. Extraer Transcripción (Múltiples Estrategias)
    let textoExtraido = "";

    // Estrategia A: Buscar por elementos de lista o bloques
    const elementos = document.querySelectorAll('[role="listitem"], [data-automation-id*="transcript"], [class*="transcript"]');
    
    if (elementos.length > 0) {
      elementos.forEach(el => {
        const txt = el.innerText.trim();
        if (txt.length > 0) textoExtraido += txt + "\n\n";
      });
    }

    // Estrategia B (Respaldo): Buscar el panel lateral completo si la Estrategia A falla
    if (!textoExtraido) {
      const panelLateral = document.querySelector('[role="region"][aria-label*="Transcript"], [class*="pane"], [class*="sidebar"]');
      if (panelLateral) {
        textoExtraido = panelLateral.innerText.trim();
      }
    }

    if (!textoExtraido) {
      sendResponse({ 
        exito: false, 
        error: "No se encontró el panel. Abre manualmente el botón 'Transcripción' en la barra derecha de Stream e intenta de nuevo." 
      });
      return true;
    }

    sendResponse({ 
      exito: true, 
      metadatos: {
        titulo: tituloVideo,
        fecha: fecha,
        hora: hora
      },
      transcripcion: textoExtraido 
    });
  }
  return true;
});