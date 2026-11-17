'use strict';
/* Start-up: runs after every other module has loaded. */
applyDevMode();
$('btnSettings').addEventListener('click', () => openSettings());
render();
LeafDash.emit('ready');
const qs = new URLSearchParams(location.search);
if (qs.has('charging')) S.demoCharging = true;
if (qs.has('demo') || qs.has('roadtest') || qs.has('charging')) startDemo();
if (qs.has('roadtest')) osmFixtureDrive();
if (qs.has('healthdemo')) htDemo();
if (qs.get('view')) showView(qs.get('view'));
if (S.mode === 'off') autoConnect();          // get back to the adapter used last time, if the browser allows
