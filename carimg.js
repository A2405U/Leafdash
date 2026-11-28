'use strict';
/* =====================================================================
   Car model pictures (car-rear.webp for the Drive screen, car-side.webp
   for the charging screen). Settings → Drive screen → Car model can
   switch back to the simple drawn car. Lights are glows placed on the
   picture, so they still follow the car's real lamps.
   ===================================================================== */

const CAR_IMG = { rear: new Image(), side: new Image(), tint: {} };
CAR_IMG.rear.src = 'car-rear.webp';
CAR_IMG.side.src = 'car-side.webp';

function carImgReady(name) {
  const im = CAR_IMG[name];
  return SET.carModel !== 'drawn' && !SET.carImage && im.complete && im.naturalWidth > 0;
}

/** The picture tinted with the chosen car colour (cached per colour). */
function carImgTinted(name) {
  const key = name + SET.carColour;
  if (CAR_IMG.tint[key]) return CAR_IMG.tint[key];
  const im = CAR_IMG[name], c = document.createElement('canvas');
  c.width = im.naturalWidth; c.height = im.naturalHeight;
  const x = c.getContext('2d');
  x.drawImage(im, 0, 0);
  const col = SET.carColour || '#e6e8eb';
  if (col.toLowerCase() !== '#e6e8eb') {
    x.globalCompositeOperation = 'multiply'; x.fillStyle = col; x.fillRect(0, 0, c.width, c.height);
    x.globalCompositeOperation = 'destination-in'; x.drawImage(im, 0, 0);
  }
  return (CAR_IMG.tint[key] = c);
}

/* ---------------- Drive screen (rear view) ---------------- */
// lamp positions on car-rear.webp, as fractions of the picture (u across, v down)
// Lamp shapes traced from the user's painted template (fractions of car-rear.webp):
// tail = side/tail lamp, brighter for brake; ind = indicators; rev = reverse; fog = rear fog light
const REAR_LAMPS = {
  tailL: [[0.127, 0.5325], [0.1243, 0.5408], [0.1217, 0.5656], [0.1151, 0.5914], [0.1151, 0.5976], [0.1099, 0.609], [0.1086, 0.6193], [0.1046, 0.6317], [0.0993, 0.6348], [0.0914, 0.6348], [0.0849, 0.6307], [0.0783, 0.6193], [0.077, 0.61], [0.0717, 0.5987], [0.0717, 0.5914], [0.0678, 0.5914], [0.0638, 0.5956], [0.0625, 0.608], [0.0572, 0.6173], [0.0533, 0.6451], [0.0559, 0.6534], [0.0586, 0.6555], [0.0638, 0.6565], [0.0704, 0.6617], [0.0836, 0.6668], [0.1164, 0.672], [0.1191, 0.6741], [0.148, 0.6772], [0.148, 0.6699], [0.1454, 0.6627], [0.1454, 0.6472], [0.1414, 0.6369], [0.1414, 0.6204], [0.1401, 0.6193], [0.1414, 0.5904], [0.1401, 0.5894], [0.1401, 0.5801], [0.1388, 0.579], [0.1388, 0.5325]],
  tailR: [[0.8757, 0.5294], [0.8625, 0.5294], [0.8625, 0.5367], [0.8651, 0.5439], [0.8651, 0.5563], [0.8612, 0.5687], [0.8599, 0.6296], [0.8572, 0.6379], [0.8572, 0.6668], [0.8546, 0.673], [0.8546, 0.6782], [0.8651, 0.6782], [0.877, 0.6741], [0.8875, 0.673], [0.8928, 0.671], [0.9033, 0.671], [0.9046, 0.672], [0.9164, 0.671], [0.9362, 0.6627], [0.9493, 0.6544], [0.948, 0.6265], [0.9454, 0.6204], [0.9454, 0.6111], [0.9428, 0.608], [0.9428, 0.6018], [0.9336, 0.5904], [0.9296, 0.5904], [0.9283, 0.5925], [0.9257, 0.6152], [0.9204, 0.6214], [0.9178, 0.6286], [0.9138, 0.6317], [0.9072, 0.6327], [0.8993, 0.6286], [0.8914, 0.6173], [0.8862, 0.5966], [0.8862, 0.5842], [0.8849, 0.5832], [0.8849, 0.5759], [0.8822, 0.5708], [0.8822, 0.5625], [0.8796, 0.5573]],
  indL: [[0.0533, 0.6544], [0.052, 0.6606], [0.0546, 0.6668], [0.0546, 0.673], [0.0612, 0.6854], [0.0757, 0.6968], [0.1007, 0.7082], [0.1059, 0.7082], [0.1059, 0.6968], [0.1072, 0.6958], [0.1072, 0.6854], [0.1086, 0.6844], [0.1072, 0.6741], [0.0954, 0.672], [0.0901, 0.6699], [0.0888, 0.6679], [0.0757, 0.6658], [0.0638, 0.6575]],
  indR: [[0.9493, 0.6565], [0.9467, 0.6565], [0.9362, 0.6637], [0.9296, 0.6658], [0.9178, 0.672], [0.9072, 0.673], [0.9112, 0.6854], [0.9125, 0.6968], [0.9164, 0.704], [0.9217, 0.704], [0.9283, 0.702], [0.9283, 0.6989], [0.9401, 0.6906], [0.948, 0.671]],
  revL: [[0.1099, 0.6751], [0.1099, 0.704], [0.1086, 0.7092], [0.1125, 0.7123], [0.1257, 0.7175], [0.1388, 0.7195], [0.1441, 0.7226], [0.173, 0.7319], [0.1783, 0.7319], [0.1783, 0.7299], [0.1704, 0.7195], [0.1572, 0.6906], [0.152, 0.6834], [0.148, 0.6803], [0.1349, 0.6803]],
  revR: [[0.9059, 0.6751], [0.9007, 0.672], [0.8967, 0.672], [0.8664, 0.6803], [0.8559, 0.6803], [0.8533, 0.6896], [0.8507, 0.6927], [0.8507, 0.6958], [0.8454, 0.7061], [0.8375, 0.7154], [0.8296, 0.7309], [0.8441, 0.7299], [0.8638, 0.7247], [0.8691, 0.7247], [0.8928, 0.7164], [0.9007, 0.7092], [0.9138, 0.7071], [0.9138, 0.703], [0.9099, 0.6958], [0.9099, 0.6896], [0.9072, 0.6844]],
  fog: [[0.4757, 0.952], [0.4743, 0.9561], [0.4757, 0.9799], [0.5257, 0.9799], [0.5257, 0.952]],
  brake3: [[0.40, 0.402], [0.60, 0.402], [0.60, 0.412], [0.40, 0.412]],
};

function drawCarImg(g, cam, opt) {
  const { cx, y0, k, s, zr } = cam;
  const proj = (X, Y, z) => { const Z = zr + z; return [cx + X * s * k / Z, y0 + k * (1 - Y * s) / Z]; };
  const P = opt.P || 0, Lt = opt.lights || { tail: true };
  const blinkOn = Math.floor(performance.now() / 380) % 2 === 0;
  const indL = Lt.indL && blinkOn, indR = Lt.indR && blinkOn;
  const tail = Lt.brake ? 1 : Lt.tail ? 0.55 + P * 0.35 : 0;

  // size: as wide as the car at its rear bumper, as tall as the car's roof / bonnet appear from the camera
  const [, yGround] = proj(0, 0, 0.05);
  const halfW = 1.0 * s * k / (zr + 0.05);
  const yTop = Math.min(proj(0, 1.55, 2.0)[1], proj(0, 0.85, 4.3)[1]);
  const im = carImgTinted('rear');
  const w = halfW * 2 * 0.98, v0 = 0.03, v1 = 0.975;                 // picture rows the car body spans
  const hCar = yGround - yTop, h = Math.min(hCar / (v1 - v0), w * 0.98);
  const x = cx - w / 2, y = yGround - v1 * h;
  const at = ([u, v]) => [x + u * w, y + v * h];

  // road light pools (behind the car)
  const pool = (X, z, rM, rgba, squash = 0.22) => {
    const [px, py] = proj(X, 0, z), pr = rM * s * k / Math.max(0.3, zr + z);
    const gr = g.createRadialGradient(px, py, 0, px, py, pr);
    gr.addColorStop(0, rgba); gr.addColorStop(1, rgba.replace(/[\d.]+\)$/, '0)'));
    g.save(); g.translate(px, py); g.scale(1, squash); g.translate(-px, -py);
    g.globalCompositeOperation = 'lighter'; g.fillStyle = gr; g.fillRect(px - pr, py - pr, pr * 2, pr * 2); g.restore();
  };
  const beam = (pts, zN, zF, a) => {
    const yN = proj(0, 0, zN)[1], yF = proj(0, 0, zF)[1], gr = g.createLinearGradient(0, yN, 0, yF);
    gr.addColorStop(0, `rgba(255,244,220,${a})`); gr.addColorStop(0.6, `rgba(255,244,220,${a * 0.45})`); gr.addColorStop(1, 'rgba(255,244,220,0)');
    g.save(); g.globalCompositeOperation = 'lighter'; g.filter = 'blur(10px)'; g.fillStyle = gr;
    g.beginPath(); pts.forEach(([X, z], i) => { const [px, py] = proj(X, 0, z); i ? g.lineTo(px, py) : g.moveTo(px, py); }); g.closePath(); g.fill(); g.restore();
  };
  const F = 4.3;
  // dipped: spreads across all lanes but stops short (UK: reaches a little further on the left); main beam: same width, much further
  const N = F - 0.9;                                    // start under the bonnet so the light meets the car
  // both spread out straight away from the corners of the car, so the light fills the lanes in front rather than
  // sitting behind the car as a thin column (1.9: they were too narrow, most clearly on the car screen)
  if (Lt.high) beam([[-1.4, N], [1.4, N], [7.5, F + 7], [8.0, F + 80], [-8.0, F + 80], [-7.5, F + 7]], N, F + 80, 0.4);
  if (Lt.low || Lt.high) beam([[-1.4, N], [1.4, N], [7.0, F + 6], [7.4, F + 24], [-7.4, F + 28], [-7.0, F + 6]], N, F + 28, 0.5);
  if (tail > 0) pool(0, 0.05, Lt.brake ? 1.3 : 0.9, `rgba(255,40,60,${(Lt.brake ? 0.45 : 0.3) * tail})`);
  if (Lt.reverse) pool(0, -0.35, 1.25, 'rgba(235,240,255,.38)', 0.26);
  if (indL) { pool(-1.0, 0.1, 0.9, 'rgba(255,160,20,.6)'); pool(-1.15, 2.5, 0.75, 'rgba(255,160,20,.5)', 0.3); }
  if (indR) { pool(1.0, 0.1, 0.9, 'rgba(255,160,20,.6)'); pool(1.15, 2.5, 0.75, 'rgba(255,160,20,.5)', 0.3); }

  // contact shadow
  g.save(); g.filter = 'blur(8px)'; g.fillStyle = 'rgba(0,0,0,.6)';
  g.beginPath(); g.ellipse(cx, yGround - h * 0.02, w * 0.47, h * 0.05, 0, 0, Math.PI * 2); g.fill(); g.restore();

  // the car (blue rim glow in warp)
  g.save();
  if (P > 0.02) { g.shadowColor = `rgba(130,170,255,${0.9 * P})`; g.shadowBlur = 30 * P; }
  g.drawImage(im, x, y, w, h);
  g.restore();

  // lamps
  const lamp = (pts, col, a, blur) => {
    if (a <= 0) return;
    const pth = new Path2D(); pts.forEach((p, i) => { const [px, py] = at(p); i ? pth.lineTo(px, py) : pth.moveTo(px, py); }); pth.closePath();
    g.save();
    g.shadowColor = col; g.shadowBlur = blur;
    g.fillStyle = col.replace(/[\d.]+\)$/, `${a})`); g.fill(pth);          // lamp lens
    g.globalCompositeOperation = 'lighter'; g.shadowBlur = blur * 1.6;
    g.fillStyle = col.replace(/[\d.]+\)$/, `${a * 0.5})`); g.fill(pth);    // bloom
    g.restore();
  };
  const red = 'rgba(255,30,50,1)';
  const tailA = Lt.brake ? 1 : tail * 0.62;                       // same lamp: dim for tail, bright for brake
  lamp(REAR_LAMPS.tailL, red, tailA, Lt.brake ? 16 : 6);
  lamp(REAR_LAMPS.tailR, red, tailA, Lt.brake ? 16 : 6);
  if (Lt.brake) lamp(REAR_LAMPS.brake3, red, 1, 12);
  if (Lt.fog) lamp(REAR_LAMPS.fog, red, 1, 14);
  if (Lt.reverse) { lamp(REAR_LAMPS.revL, 'rgba(240,245,255,1)', 0.95, 10); lamp(REAR_LAMPS.revR, 'rgba(240,245,255,1)', 0.95, 10); }
  const amber = 'rgba(255,165,20,1)';
  // mirror repeaters face forwards, so from behind only their glow on the road shows (drawn with the pools)
  if (indL) lamp(REAR_LAMPS.indL, amber, 1, 10);
  if (indR) lamp(REAR_LAMPS.indR, amber, 1, 10);
}

/* ---------------- Charging screen (side view) ---------------- */
// key points on car-side.webp (1600 × 630): front on the left
const SIDE = { w: 1600, h: 630, ground: 618, pack: [505, 500, 1165, 534], port: [108, 288],
  // route from the port over the front wheel arch, down behind the wheel to the pack
  flow: [[108, 288], [190, 330], [335, 345], [450, 380], [480, 470], [511, 517]] };

function drawChargeSceneImg(g, W, H, d, t) {
  const bg = g.createRadialGradient(W / 2, H * 0.42, 10, W / 2, H * 0.42, Math.max(W, H) * 0.8);
  bg.addColorStop(0, '#111a24'); bg.addColorStop(1, '#05070a');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);

  // centred when there's room in front of it for the charging cable; otherwise (phone held upright) moved right
  const sc = Math.min(W * 0.8 / SIDE.w, H * 0.42 / SIDE.h);
  const w = SIDE.w * sc, h = SIDE.h * sc, x = (W - w) / 2 >= W * 0.12 ? (W - w) / 2 : W - w - W * 0.04, yG = H * 0.52, y = yG - SIDE.ground * sc;
  const at = (px, py) => [x + px * sc, y + py * sc];

  // floor glow and contact shadow
  const fl = g.createLinearGradient(0, yG, 0, yG + 40);
  fl.addColorStop(0, 'rgba(76,195,255,.10)'); fl.addColorStop(1, 'rgba(76,195,255,0)');
  g.fillStyle = fl; g.fillRect(0, yG, W, 40);                              // full width: the cable lies on it too
  g.fillStyle = 'rgba(0,0,0,.5)';
  g.beginPath(); g.ellipse(x + w / 2, yG + 1, w * 0.48, 6, 0, 0, Math.PI * 2); g.fill();

  // the cable first: its end is hidden behind the near side of the nose, as from this angle
  const ck = Math.max(0.7, Math.min(1.8, w / 360));
  drawCable(g, ...at(...SIDE.port), at(18, 0)[0], yG, ck, d.chargeMode);
  // x-ray car, slightly see-through so the pack reads as inside it
  g.save(); g.globalAlpha = 0.9; g.drawImage(carImgTinted('side'), x, y, w, h); g.restore();

  const [bx, by] = at(SIDE.pack[0], SIDE.pack[1]), [bx2, by2] = at(SIDE.pack[2], SIDE.pack[3]);
  drawPack(g, bx, by, bx2 - bx, by2 - by, d, t);
  drawFlow(g, SIDE.flow.map(p => at(...p)), yG, t, { kind: d.chargeMode, kw: chargeKw(d) });
}
