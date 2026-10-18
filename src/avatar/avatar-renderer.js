import * as T from 'three';
import { prepareDigitalHuman } from './digital-human.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export async function createAvatarScene(
  container,
  { signal, getSpeechFrame, getReducedMotion, getThinking, getPresenting, onPhase = () => {} },
) {
  let renderer;
  try {
    renderer = new T.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
    });
  } catch {
    throw new Error(
      '3D rendering is unavailable on this device. You can still use chat and voice.',
    );
  }
  const scene = new T.Scene(),
    camera = new T.PerspectiveCamera(28, 1, 0.01, 20);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFSoftShadowMap;
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.domElement.setAttribute('aria-label', 'Alya, your animated 3D avatar');
  renderer.domElement.setAttribute('role', 'img');
  container.appendChild(renderer.domElement);
  const pmrem = new T.PMREMGenerator(renderer),
    room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.03);
  scene.environment = environment.texture;
  room.dispose();
  pmrem.dispose();
  scene.add(new T.HemisphereLight('#dce9ef', '#18232d', 0.35));
  for (const [color, power, position] of [
    ['#fff1e8', 2.8, [-2.5, 3.2, 2.6]],
    ['#c5dfef', 0.85, [2, 1.9, 2]],
    ['#9bdbcf', 2.4, [1.2, 2.2, -1.6]],
  ]) {
    const light = new T.DirectionalLight(color, power);
    light.position.set(...position);
    light.target.position.set(0, 1.6, 0);
    if (position[0] < 0) {
      light.castShadow = true;
      light.shadow.mapSize.set(1024, 1024);
      Object.assign(light.shadow.camera, {
        left: -0.65,
        right: 0.65,
        top: 0.65,
        bottom: -0.65,
        near: 0.1,
        far: 8,
      });
      light.shadow.bias = -0.0002;
      light.shadow.normalBias = 0.002;
    }
    scene.add(light, light.target);
  }
  let model = null,
    raf = 0,
    disposed = false,
    lastFrame = 0;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  function resize() {
    const { width, height } = container.getBoundingClientRect();
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    const compact = height < 400 || camera.aspect < 0.36;
    camera.position.set(
      0.065,
      compact ? 1.66 : 1.6,
      compact ? (camera.aspect < 0.36 ? 1.45 : 1.1) : Math.max(1.55, 0.95 / camera.aspect),
    );
    camera.lookAt(0, compact ? 1.65 : 1.57, 0);
    camera.updateProjectionMatrix();
    // Resize clears the WebGL buffer, including while a tab is in the background.
    if (model) renderer.render(scene, camera);
  }
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();
  const contextLost = (event) => {
    event.preventDefault();
    onPhase(
      'unavailable',
      'The 3D view needs more graphics memory. Chat and voice are still available.',
    );
  };
  renderer.domElement.addEventListener('webglcontextlost', contextLost);
  function disposeModel(root) {
    const materials = new Set(),
      textures = new Set();
    root?.traverse((o) => {
      o.geometry?.dispose();
      if (o.skeleton?.boneTexture) textures.add(o.skeleton.boneTexture);
      for (const material of Array.isArray(o.material)
        ? o.material
        : o.material
          ? [o.material]
          : []) {
        materials.add(material);
        for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
      }
    });
    textures.forEach((t) => t.dispose());
    materials.forEach((m) => m.dispose());
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    observer.disconnect();
    renderer.domElement.removeEventListener('webglcontextlost', contextLost);
    disposeModel(model);
    environment.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  }
  signal.addEventListener('abort', dispose, { once: true });
  try {
    onPhase('loading', 'Preparing Alya…');
    const metadataResponse = await fetch('/avatars/alya/manifest.json', { signal });
    if (!metadataResponse.ok) throw new Error('Avatar metadata could not load.');
    const metadata = await metadataResponse.json();
    const response = await fetch(
      '/avatars/alya/alya.glb?v=' + encodeURIComponent(metadata.sha256.slice(0, 12)),
      { signal },
    );
    if (!response.ok) throw new Error('The avatar file could not load.');
    const bytes = await response.arrayBuffer();
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    onPhase('loading', 'Preparing the 3D view…');
    const gltf = await new GLTFLoader().parseAsync(bytes, '');
    model = gltf.scene;
    if (signal.aborted) {
      disposeModel(model);
      throw new DOMException('Aborted', 'AbortError');
    }
    prepareDigitalHuman(model, renderer);
    scene.add(model);
    const morphs = new Map();
    model.traverse((o) => {
      for (const [name, index] of Object.entries(o.morphTargetDictionary || {})) {
        if (!morphs.has(name)) morphs.set(name, []);
        morphs.get(name).push([o, index]);
      }
    });
    const set = (name, value) => {
      for (const [mesh, index] of morphs.get(name) || []) mesh.morphTargetInfluences[index] = value;
    };
    const expressionLevels = new Map();
    const ease = (name, target, dt) => {
      const value = T.MathUtils.damp(expressionLevels.get(name) || 0, target, 6, dt);
      expressionLevels.set(name, value);
      set(name, value);
    };
    const mouthNames = [...morphs.keys()].filter((name) => name.startsWith('viseme_'));
    const levels = new Map(mouthNames.map((name) => [name, 0]));
    // The bones that carry her posture, with their authored rest rotations.
    const bone = (name) => model.getObjectByName(name);
    const hips = bone('Hips'),
      spine1 = bone('Spine1'),
      chest = bone('Spine2'),
      neck = bone('Neck'),
      head = bone('Head'),
      leftShoulder = bone('LeftShoulder'),
      rightShoulder = bone('RightShoulder'),
      leftEye = bone('LeftEye'),
      rightEye = bone('RightEye');
    const restOf = (o) => o?.quaternion.clone();
    const rest = {
      hips: restOf(hips),
      spine1: restOf(spine1),
      chest: restOf(chest),
      neck: restOf(neck),
      head: restOf(head),
      leftShoulder: restOf(leftShoulder),
      rightShoulder: restOf(rightShoulder),
    };
    const euler = new T.Euler(),
      delta = new T.Quaternion(),
      eyeMid = new T.Vector3(),
      toCamera = new T.Vector3(),
      eyeLocal = new T.Vector3();
    // Rotate a bone from its rest pose, in its own frame (spine, neck, head) or in
    // its parent's frame (the shoulders, whose own axes are turned).
    const pose = (o, restQ, x, y, z, inParent = false) => {
      if (!o) return;
      delta.setFromEuler(euler.set(x, y, z));
      if (inParent) o.quaternion.copy(delta).multiply(restQ);
      else o.quaternion.copy(restQ).multiply(delta);
    };
    // Slow, uneven movement: three sines that never line up, so nothing repeats visibly.
    const drift = (t, a, b, c) =>
      (Math.sin(t * a) + Math.sin(t * b + 1.3) + Math.sin(t * c + 2.1)) / 3;
    // How far her head has turned toward the camera, and a short look-away at times.
    const gaze = { yaw: 0, pitch: 0, glanceUntil: 0, nextGlance: 6000, glanceX: 0, glanceY: 0 };
    const eyeLevels = { yaw: 0, pitch: 0 };
    const headTurnLimit = { yaw: 0.6, pitch: 0.42 };
    // Her body faces the viewer, with a slight natural turn rather than a rigid front.
    model.rotation.y = 0.025;
    let nextBlink = performance.now() + 2400,
      blinkStart = 0,
      ready = false;
    function tick(now) {
      if (disposed || signal.aborted) return;
      raf = requestAnimationFrame(tick);
      if (now - lastFrame < 1000 / 30 || document.hidden) return;
      const dt = Math.min(0.1, (now - lastFrame) / 1000);
      lastFrame = now;
      const frame = getSpeechFrame?.(now) || { speaking: false, viseme: 'sil', value: 0 };
      for (const name of mouthNames) {
        const target = name === 'viseme_' + frame.viseme ? frame.value : 0;
        const next = T.MathUtils.lerp(levels.get(name), target, 1 - Math.exp(-dt * 28));
        levels.set(name, next);
        set(name, next);
      }
      if (now > nextBlink && !blinkStart) {
        blinkStart = now;
        nextBlink = now + 3200 + Math.random() * 2200;
      }
      const blink = blinkStart ? Math.max(0, Math.sin((Math.PI * (now - blinkStart)) / 230)) : 0;
      if (blinkStart && now - blinkStart > 230) blinkStart = 0;
      const reduced = reduce.matches || getReducedMotion?.();
      set('eyeBlinkLeft', reduced ? 0 : blink);
      set('eyeBlinkRight', reduced ? 0 : blink);
      const thinking = getThinking?.() && !frame.speaking;
      ease('mouthSmileLeft', frame.speaking ? 0.03 : thinking ? 0.05 : 0.16, dt);
      ease('mouthSmileRight', frame.speaking ? 0.03 : thinking ? 0.05 : 0.15, dt);
      ease('eyeSquintLeft', 0.05, dt);
      ease('eyeSquintRight', 0.05, dt);
      ease('browInnerUp', thinking ? 0.09 : 0.025, dt);
      ease('cheekSquintLeft', frame.speaking ? 0.015 : 0.04, dt);
      ease('cheekSquintRight', frame.speaking ? 0.015 : 0.04, dt);
      const seconds = now / 1000;
      const speaking = Boolean(frame.speaking);
      // --- Posture: breathing, weight shift and small asymmetry (none when motion is reduced).
      const breath = reduced ? 0 : Math.sin(seconds * Math.PI * 2 * 0.26);
      const sway = reduced ? 0 : drift(seconds, 0.21, 0.37, 0.53);
      const settle = reduced ? 0 : drift(seconds, 0.33, 0.59, 0.91);
      model.position.y = reduced ? 0 : breath * 0.0012;
      pose(hips, rest.hips, 0, sway * 0.018, sway * 0.014);
      pose(spine1, rest.spine1, breath * 0.004, -sway * 0.01, -sway * 0.01);
      // The chest stands a little straighter than the authored lean and rises with each breath.
      pose(
        chest,
        rest.chest,
        -0.035 + breath * 0.009,
        -sway * 0.012 + settle * 0.004,
        -sway * 0.008,
      );
      // One shoulder rests slightly lower than the other; both lift a little as she breathes.
      pose(leftShoulder, rest.leftShoulder, 0, 0, -0.03 + breath * 0.006 + settle * 0.004, true);
      pose(rightShoulder, rest.rightShoulder, 0, 0, 0.012 - breath * 0.006 - settle * 0.004, true);
      // --- Head: a soft tilt, a small nod while she speaks, and the turn toward the viewer.
      const nod = speaking ? Math.sin(seconds * 3.1) * 0.012 : Math.sin(seconds * 0.7) * 0.004;
      const tilt = reduced ? 0 : 0.03 + settle * 0.012 + sway * 0.01;
      pose(neck, rest.neck, gaze.pitch * 0.3, gaze.yaw * 0.3, tilt * 0.4);
      pose(head, rest.head, gaze.pitch * 0.7 + nod, gaze.yaw * 0.7, tilt * 0.6);
      // --- Eye contact: aim at the camera. The head turns most of the way and the eyes
      // take what is left, measured after the pose above, so the gaze lands on the viewer.
      model.updateMatrixWorld(true);
      if (head && leftEye && rightEye) {
        leftEye
          .getWorldPosition(eyeMid)
          .add(rightEye.getWorldPosition(toCamera))
          .multiplyScalar(0.5);
        eyeLocal.copy(eyeMid);
        head.worldToLocal(eyeLocal);
        toCamera.copy(camera.position);
        head.worldToLocal(toCamera);
        toCamera.sub(eyeLocal);
        const yawError = Math.atan2(toCamera.x, toCamera.z);
        const pitchError = Math.atan2(toCamera.y, Math.hypot(toCamera.x, toCamera.z));
        // Turn the head toward the viewer, a little each frame, within a natural range.
        const follow = 1 - Math.exp(-dt * (reduced ? 12 : 3.2));
        gaze.yaw = T.MathUtils.clamp(
          gaze.yaw + yawError * 0.7 * follow,
          -headTurnLimit.yaw,
          headTurnLimit.yaw,
        );
        // A positive pitch turns the head down, so looking up needs a negative one.
        gaze.pitch = T.MathUtils.clamp(
          gaze.pitch - pitchError * 0.7 * follow,
          -headTurnLimit.pitch,
          headTurnLimit.pitch,
        );
        // Eyes: the remaining angle, plus tiny natural shifts and a rare, brief look away.
        if (!reduced) {
          if (now > gaze.nextGlance && now > gaze.glanceUntil) {
            gaze.glanceUntil = now + (getThinking?.() ? 1100 : 550);
            gaze.nextGlance = now + 7000 + Math.random() * 6000;
            gaze.glanceX = (Math.random() < 0.5 ? -1 : 1) * (0.08 + Math.random() * 0.05);
            gaze.glanceY = getThinking?.() ? 0.1 : 0.03;
          }
        }
        const glancing = !reduced && now < gaze.glanceUntil;
        const microX = reduced ? 0 : drift(seconds, 1.9, 3.1, 4.7) * 0.012;
        const microY = reduced ? 0 : drift(seconds, 1.3, 2.9, 4.1) * 0.008;
        const eyeYaw = yawError + microX + (glancing ? gaze.glanceX : 0);
        const eyePitch = pitchError + microY + (glancing ? gaze.glanceY : 0);
        const range = 0.45;
        eyeLevels.yaw = T.MathUtils.clamp(eyeYaw / range, -1, 1);
        eyeLevels.pitch = T.MathUtils.clamp(eyePitch / range, -1, 1);
      }
      const x = eyeLevels.yaw,
        y = eyeLevels.pitch;
      for (const side of ['Left', 'Right']) {
        ease('eyeLookUp' + side, Math.max(0, y), dt);
        ease('eyeLookDown' + side, Math.max(0, -y), dt);
        ease('eyeLookOut' + side, Math.max(0, side === 'Left' ? x : -x), dt);
        ease('eyeLookIn' + side, Math.max(0, side === 'Left' ? -x : x), dt);
      }
      renderer.render(scene, camera);
      if (!ready) {
        ready = true;
        onPhase('ready', 'Alya is ready');
      }
    }
    raf = requestAnimationFrame(tick);
    return { dispose };
  } catch (error) {
    dispose();
    if (error.name === 'AbortError') throw error;
    throw new Error(
      error.message || 'The 3D avatar could not load. Chat and voice remain available.',
    );
  }
}
