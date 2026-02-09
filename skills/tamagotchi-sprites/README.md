# Tamagotchi 3D Device & Sprite Design

## Overview

This skill covers creating 3D Tamagotchi-style virtual pet devices using Three.js/React Three Fiber, including device shell geometry, LCD screen rendering, pixel art sprites, and animations.

## Device Shell Geometry

### Body Shape
Use `ExtrudeGeometry` with an oval/ellipse profile (taller than wide):

```typescript
const bodyGeometry = useMemo(() => {
  const shape = new THREE.Shape();

  // Oval shape - slightly taller than wide like a real Tamagotchi
  const radiusX = 0.34;  // horizontal radius
  const radiusY = 0.42;  // vertical radius (taller)
  const segments = 64;

  // Draw oval
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    const x = Math.cos(angle) * radiusX;
    const y = Math.sin(angle) * radiusY;
    if (i === 0) {
      shape.moveTo(x, y);
    } else {
      shape.lineTo(x, y);
    }
  }

  const extrudeSettings = {
    depth: 0.12,
    bevelEnabled: true,
    bevelThickness: 0.04,
    bevelSize: 0.04,
    bevelSegments: 6,
    curveSegments: 64,
  };

  const geometry = new THREE.ExtrudeGeometry(shape, extrudeSettings);
  geometry.translate(0, 0, -0.10);
  return geometry;
}, []);
```

### Shell Material
Use `MeshPhysicalMaterial` with clearcoat for glossy plastic look:

```typescript
<meshPhysicalMaterial
  color={shellColor}        // Bright colors: pink, purple, blue, yellow
  roughness={0.1}
  metalness={0.0}
  clearcoat={1.0}
  clearcoatRoughness={0.05}
  emissive={glowColor}
  emissiveIntensity={0.08}
/>
```

### Starburst Frame
Create 8-pointed star around the screen:

```typescript
const starburstGeometry = useMemo(() => {
  const shape = new THREE.Shape();
  const points = 8;
  const outerRadius = 0.32;
  const innerRadius = 0.25;

  for (let i = 0; i < points * 2; i++) {
    const angle = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    const radius = i % 2 === 0 ? outerRadius : innerRadius;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();

  return new THREE.ExtrudeGeometry(shape, {
    depth: 0.02,
    bevelEnabled: true,
    bevelThickness: 0.005,
    bevelSize: 0.005,
    bevelSegments: 2,
  });
}, []);
```

## LCD Screen

### Canvas Setup
```typescript
const CANVAS_WIDTH = 64;
const CANVAS_HEIGHT = 64;
const PIXEL_SIZE = 2;
const SPRITE_SCALE = 6;

// Classic LCD green color palette
const LCD_COLORS = {
  background: '#9bbc0f',
  backgroundDark: '#8bac0f',
  pixel: '#0f380f',
  pixelLight: '#306230',
};
```

### Screen Mesh
```typescript
<mesh position={[0, 0.05, 0.18]}>
  <planeGeometry args={[0.32, 0.32]} />
  <meshBasicMaterial map={texture} />
</mesh>
```

## Pixel Art Sprites (8x8)

### Sprite Format
Each sprite is an 8x8 array where 1 = filled pixel, 0 = empty:

```typescript
export type SpriteFrame = number[][];
```

### Cute Pet Design Principles
1. **Round blob body** - Fill most of the 8x8 grid
2. **Dot eyes** - Use 0s (empty pixels) inside filled area for eyes
3. **Small mouth** - Optional, use 0s for smile
4. **Little feet** - Two pixels at bottom, separated

### Example Sprites

```typescript
// Idle - standing cute blob
idle: [
  [0, 0, 1, 1, 1, 1, 0, 0],
  [0, 1, 1, 1, 1, 1, 1, 0],
  [1, 1, 0, 1, 1, 0, 1, 1],  // eyes are the 0s
  [1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 0, 0, 1, 1, 1],  // mouth
  [0, 1, 1, 1, 1, 1, 1, 0],
  [0, 0, 1, 0, 0, 1, 0, 0],  // feet
  [0, 0, 1, 0, 0, 1, 0, 0],
],

// Bounce/Happy - arms up
bounce1: [
  [0, 1, 0, 0, 0, 0, 1, 0],  // raised arms
  [0, 0, 1, 1, 1, 1, 0, 0],
  [0, 1, 1, 1, 1, 1, 1, 0],
  [1, 1, 0, 1, 1, 0, 1, 1],
  [0, 1, 1, 1, 1, 1, 1, 0],
  [0, 1, 1, 0, 0, 1, 1, 0],
  [0, 0, 1, 1, 1, 1, 0, 0],
  [0, 0, 1, 0, 0, 1, 0, 0],
],

// Sleep - laying flat blob
sleep: [
  [0, 0, 0, 0, 1, 1, 1, 0],  // Zzz
  [0, 0, 0, 0, 0, 0, 1, 0],
  [0, 1, 1, 1, 1, 1, 0, 0],
  [1, 1, 1, 1, 1, 1, 1, 0],
  [1, 1, 1, 1, 1, 1, 1, 0],
  [1, 1, 1, 1, 1, 1, 1, 0],
  [0, 1, 1, 1, 1, 1, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0],
],

// Sick/Sad - droopy with splayed feet
sick: [
  [0, 0, 1, 1, 1, 1, 0, 0],
  [0, 1, 1, 1, 1, 1, 1, 0],
  [1, 1, 0, 1, 1, 0, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 0, 1, 1, 0, 1, 1],  // frown
  [0, 1, 1, 1, 1, 1, 1, 0],
  [0, 0, 1, 0, 0, 1, 0, 0],
  [0, 1, 0, 0, 0, 0, 1, 0],  // splayed feet
],

// Egg
egg: [
  [0, 0, 0, 1, 1, 0, 0, 0],
  [0, 0, 1, 1, 1, 1, 0, 0],
  [0, 1, 1, 1, 1, 1, 1, 0],
  [0, 1, 1, 1, 1, 1, 1, 0],
  [0, 1, 1, 1, 1, 1, 1, 0],
  [0, 1, 1, 1, 1, 1, 1, 0],
  [0, 0, 1, 1, 1, 1, 0, 0],
  [0, 0, 0, 1, 1, 0, 0, 0],
],
```

### Drawing Sprites
```typescript
const drawSprite = (
  ctx: CanvasRenderingContext2D,
  sprite: SpriteFrame,
  x: number,
  y: number,
  scale: number = SPRITE_SCALE
) => {
  ctx.fillStyle = LCD_COLORS.pixel;
  sprite.forEach((row, rowIdx) => {
    row.forEach((pixel, colIdx) => {
      if (pixel) {
        ctx.fillRect(
          (x + colIdx * scale) * PIXEL_SIZE,
          (y + rowIdx * scale) * PIXEL_SIZE,
          scale * PIXEL_SIZE,
          scale * PIXEL_SIZE
        );
      }
    });
  });
};

// Center the sprite on canvas
const spriteSize = 8 * SPRITE_SCALE;
const charX = (CANVAS_WIDTH - spriteSize) / 2;
const charY = (CANVAS_HEIGHT - spriteSize) / 2 - 2;
drawSprite(ctx, sprite, charX, charY, SPRITE_SCALE);
```

## Animation System

### Status to Animation Mapping
```typescript
const statusAnimations: Record<string, string[]> = {
  running: ['idle', 'bounce1', 'idle', 'bounce2'],
  paused: ['sleep'],
  stopped: ['egg'],
  error: ['sick'],
  starting: ['egg', 'hatching', 'idle'],
  pending: ['egg'],
};
```

### Frame Timing
```typescript
useFrame((state) => {
  // Update animation frame every 500ms
  if (state.clock.elapsedTime - lastFrameTime.current > 0.5) {
    frameRef.current++;
    lastFrameTime.current = state.clock.elapsedTime;
  }

  const sprite = getCurrentSprite(status, frameRef.current);
  // ... draw sprite
});
```

## Buttons

### Button Component
```typescript
<group position={[0, -0.32, 0.16]}>
  {/* Three buttons spaced horizontally */}
  <Button position={[-0.08, 0, 0]} /> {/* Left */}
  <Button position={[0, 0, 0]} />      {/* Center */}
  <Button position={[0.08, 0, 0]} />   {/* Right */}
</group>
```

### Button Geometry
```typescript
// Base socket
<mesh rotation={[Math.PI / 2, 0, 0]}>
  <cylinderGeometry args={[0.032, 0.035, 0.015, 16]} />
  <meshStandardMaterial color="#7f1d1d" roughness={0.7} />
</mesh>

// Button sphere
<mesh>
  <sphereGeometry args={[0.028, 16, 16]} />
  <meshPhysicalMaterial
    color="#ef4444"
    roughness={0.15}
    clearcoat={1.0}
    clearcoatRoughness={0.05}
    emissive="#ff0000"
    emissiveIntensity={0.05}
  />
</mesh>
```

## Color Palettes

### Bright Tamagotchi Colors
Real Tamagotchis use bright, fun colors:

```typescript
const tamagotchiColors = {
  // Pink/Purple variants
  pink: { shell: '#ec4899', accent: '#f472b6', glow: '#f9a8d4' },
  purple: { shell: '#a855f7', accent: '#c084fc', glow: '#d8b4fe' },
  lavender: { shell: '#8b5cf6', accent: '#a78bfa', glow: '#c4b5fd' },

  // Blue variants
  blue: { shell: '#3b82f6', accent: '#60a5fa', glow: '#93c5fd' },
  cyan: { shell: '#06b6d4', accent: '#22d3ee', glow: '#67e8f9' },

  // Warm variants
  yellow: { shell: '#eab308', accent: '#facc15', glow: '#fde047' },
  orange: { shell: '#f97316', accent: '#fb923c', glow: '#fdba74' },
  coral: { shell: '#f87171', accent: '#fca5a5', glow: '#fecaca' },

  // Green variants
  mint: { shell: '#10b981', accent: '#34d399', glow: '#6ee7b7' },
  lime: { shell: '#84cc16', accent: '#a3e635', glow: '#bef264' },
};
```

## File Structure

```
components/gotchi3d/
├── DeviceShell.tsx      # Main body geometry & materials
├── DeviceScreen.tsx     # LCD canvas rendering
├── DeviceButtons.tsx    # Interactive buttons
├── TamagotchiDevice.tsx # Composed device component
├── sprites/
│   └── pixelSprites.ts  # Sprite definitions & animations
└── SoundManager.tsx     # Audio feedback
```

## Device Animation

### Animation Principles

**Critical:** Avoid rotation.x (pitch) animation - it makes the screen appear to move forward/backward relative to the body, causing visual glitches.

### View Mode Animation States

```typescript
useFrame((state) => {
  if (!groupRef.current) return;

  if (isPlanetView) {
    // Planet view: keep device completely stable, face camera
    groupRef.current.rotation.y = THREE.MathUtils.lerp(groupRef.current.rotation.y, 0, 0.15);
    groupRef.current.rotation.x = THREE.MathUtils.lerp(groupRef.current.rotation.x, 0, 0.15);
    groupRef.current.position.x = THREE.MathUtils.lerp(groupRef.current.position.x, position[0], 0.1);
    groupRef.current.position.y = THREE.MathUtils.lerp(groupRef.current.position.y, position[1], 0.1);
  } else if (!isSelected) {
    // Galaxy view (not selected): gentle floating motion
    const baseY = position[1];
    const floatOffset = Math.sin(state.clock.elapsedTime * 0.8 + position[0] * 2) * 0.04;
    groupRef.current.position.y = baseY + floatOffset;

    // Very subtle Y rotation only (no X rotation!)
    groupRef.current.rotation.y = Math.sin(state.clock.elapsedTime * 0.4 + position[0]) * 0.05;
    groupRef.current.rotation.x = 0;
  } else {
    // Galaxy view (selected): face camera smoothly
    groupRef.current.rotation.y = THREE.MathUtils.lerp(groupRef.current.rotation.y, 0, 0.1);
    groupRef.current.rotation.x = THREE.MathUtils.lerp(groupRef.current.rotation.x, 0, 0.1);
  }

  // Error shake - only in galaxy view, gentle
  if (agent.status === 'error' && !isPlanetView) {
    const shake = Math.sin(state.clock.elapsedTime * 8) * 0.008;
    groupRef.current.position.x = position[0] + shake;
  }
});
```

### Animation Guidelines

| View Mode | Floating | Rotation Y | Rotation X | Error Shake |
|-----------|----------|------------|------------|-------------|
| Planet (zoomed) | None | Lerp to 0 | Lerp to 0 | None |
| Galaxy (selected) | None | Lerp to 0 | Lerp to 0 | None |
| Galaxy (unselected) | Gentle Y bob | Subtle wobble | **Always 0** | Gentle |

### Key Animation Values

```typescript
// Floating motion
const floatOffset = Math.sin(time * 0.8) * 0.04;  // Slow, subtle

// Y rotation wobble (galaxy view only)
rotation.y = Math.sin(time * 0.4) * 0.05;  // Very subtle

// Error shake (galaxy view only)
const shake = Math.sin(time * 8) * 0.008;  // Gentle frequency and amplitude

// Lerp speeds for transitions
const lerpSpeed = 0.1 to 0.15;  // Smooth but responsive
```

### Common Animation Mistakes

1. **Using rotation.x** - Causes screen to appear to move in/out
2. **Too fast wobble** - Looks jittery (keep frequency < 1.0)
3. **Error shake in planet view** - Distracting when zoomed in
4. **Large rotation amplitudes** - Keep under 0.1 radians
5. **Not lerping to stable state** - Selected/planet view should stabilize

## Key Learnings

1. **Use oval, not circle** for body - Tamagotchis are egg-shaped (taller than wide)
2. **ExtrudeGeometry** works better than LatheGeometry for flat disc shapes
3. **SPRITE_SCALE of 6** makes 8x8 sprites visible on screen
4. **Remove scanlines** for better sprite visibility
5. **Clearcoat materials** give authentic glossy plastic look
6. **Bright saturated colors** match real Tamagotchi aesthetics
7. **Eyes are empty pixels** (0s) inside filled body for cute look
8. **Never use rotation.x animation** - causes forward/backward screen glitch
9. **Planet view must be stable** - no wobble, no shake, lerp to rest position
10. **Error shake only in galaxy view** - and keep it gentle (frequency ~8, amplitude ~0.008)
