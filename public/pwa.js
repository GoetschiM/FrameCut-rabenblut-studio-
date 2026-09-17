(() => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(error => console.warn('FrameCut PWA:', error));
})();
