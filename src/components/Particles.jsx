import { useMemo, useRef, useEffect } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';

export default function Particles({ effect }) {
  const count = 400;
  const mesh = useRef();
  const positions = useMemo(() => {
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      arr[i*3+0] = (Math.random()-0.5) * 6;
      arr[i*3+1] = (Math.random()-0.5) * 6;
      arr[i*3+2] = (Math.random()-0.5) * 6;
    }
    return arr;
  }, [count]);

  const color = useMemo(() => {
    switch (effect) {
      case 'aura': return 0xffd700;
      case 'flames': return 0xff3300;
      case 'shockwave': return 0x88ddff;
      case 'beam': return 0x00ff88;
      case 'heart': return 0xff66cc;
      case 'invisibility': return 0x333333;
      default: return 0x00ffff;
    }
  }, [effect]);

  useEffect(() => {
    if (mesh.current) {
      mesh.current.material.size = effect === 'shockwave' ? 0.06 : 0.04;
      mesh.current.material.needsUpdate = true;
    }
  }, [effect]);

  useFrame((state) => {
    if (!mesh.current) return;
    const t = state.clock.getElapsedTime();
    if (effect === 'aura') mesh.current.rotation.y = t * 0.2;
    else if (effect === 'flames') mesh.current.position.y = Math.sin(t * 3) * 0.1;
    else if (effect === 'shockwave') mesh.current.scale.setScalar(1 + Math.sin(t * 4) * 0.08 + 0.1);
    else if (effect === 'beam') mesh.current.rotation.z = t * 0.6;
    else if (effect === 'heart') mesh.current.rotation.x = t * 0.3;
    else if (effect === 'invisibility') mesh.current.material.opacity = 0.2;
    else mesh.current.rotation.y = t * 0.1;
  });

  return (
    <points ref={mesh}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={positions.length/3} array={positions} itemSize={3} />
      </bufferGeometry>
      <pointsMaterial size={0.04} transparent opacity={0.85} depthWrite={false} color={color} />
    </points>
  );
}
