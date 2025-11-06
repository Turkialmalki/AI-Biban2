import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: [
      '@tensorflow/tfjs',
      '@tensorflow/tfjs-backend-webgl',
      '@tensorflow/tfjs-backend-webgpu',
      '@tensorflow-models/face-detection',
      '@tensorflow-models/pose-detection',
      '@tensorflow-models/hand-pose-detection',
      '@mediapipe/face_detection',
      '@mediapipe/hands',
      '@mediapipe/pose'
    ]
  }
});