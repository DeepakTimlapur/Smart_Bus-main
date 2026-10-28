
"""
MobileFaceNet (w600k_mbf) Optimized ONNX Runtime Wrapper for Smart Bus IoT
"""
import numpy as np
import cv2
import onnxruntime as ort

class MobileFaceNetEmbedder:
    def __init__(self, model_path="models/face_embedding.onnx"):
        print(f"[INFO] Initializing MobileFaceNet (w600k_mbf) from {model_path}...")
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 2
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        
        self.session = ort.InferenceSession(model_path, options, providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name
        self.output_name = self.session.get_outputs()[0].name
        
        print("[SUCCESS] MobileFaceNet model loaded and optimized for edge inference.")

    def get_embedding(self, aligned_face_img):
        """
        Takes a 112x112 aligned face crop, normalizes, and extracts 512-d L2-normalized embedding.
        """
        if aligned_face_img.shape[:2] != (112, 112):
            aligned_face_img = cv2.resize(aligned_face_img, (112, 112))
            
        # Preprocessing: scale to [-1, 1] using mean=127.5, std=127.5
        blob = cv2.dnn.blobFromImages(
            [aligned_face_img], 
            scalefactor=1.0 / 127.5, 
            size=(112, 112), 
            mean=(127.5, 127.5, 127.5), 
            swapRB=True
        )
        
        # Run ONNX inference
        embedding = self.session.run([self.output_name], {self.input_name: blob})[0]
        
        # L2 Normalization for accurate cosine similarity matching
        embedding = embedding.flatten()
        norm = np.linalg.norm(embedding)
        if norm > 0:
            embedding = embedding / norm
            
        return embedding

