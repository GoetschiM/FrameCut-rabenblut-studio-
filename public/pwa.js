(() => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js?v=1007').then(registration => registration.update()).catch(error => console.warn('FrameCut PWA:', error));
})();
