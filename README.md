# Next-Gen Smart Bus Entry System Using Vision Intelligence and IoT

## Overview

The Next-Gen Smart Bus Entry System is an intelligent transportation solution designed to improve passenger safety, automate bus entry management, and enhance public transport efficiency using Vision Intelligence and IoT technologies. The system uses camera-based monitoring, facial recognition or passenger detection, RFID/QR authentication, and real-time IoT communication to create a secure and automated smart bus environment.

This project focuses on reducing manual verification, improving passenger tracking, minimizing overcrowding, and providing real-time data analytics for transport authorities.

---

# Features

## 🚀 Key Features

### Real-Time GPS Tracking

* Live bus location monitoring using GPS modules
* Accurate ETA prediction using historical traffic analysis
* Real-time route tracking for passengers and administrators

### Automated Passenger Counting (APC)

* Overhead sensors and AI cameras for occupancy monitoring
* Prevents overcrowding through live passenger counting
* Generates occupancy analytics for transport management

### Contactless Smart Ticketing

* RFID and QR-code-based digital ticketing system
* Cashless payment integration for faster boarding
* Secure passenger authentication and travel logging

### Driver Assistance & Safety

* AI-powered driver drowsiness detection
* Harsh braking and unsafe driving alerts
* Emergency safety notifications for administrators

### Eco-Drive Insights

* Analytics dashboard for monitoring fuel and battery usage
* Optimizes fleet performance and operational efficiency
* Supports sustainable smart transportation systems

---

# Technologies Used

## 💻 Tech Stack

### Hardware

* Raspberry Pi 4
* Neo-6M GPS Module
* MFRC522 RFID Module
* Pi Camera
* Arduino / ESP32
* Sensors and IoT Devices

### Backend

* Node.js
* Python (FastAPI)

### Frontend & Mobile

* React.js
* Flutter
* HTML
* CSS
* JavaScript

### Database

* MongoDB (User and Route Data)
* InfluxDB (Time-Series IoT Telemetry)

### Messaging Broker

* MQTT
* Apache Kafka

### AI & Vision Intelligence

* OpenCV
* TensorFlow
* YOLO
* Face Detection Libraries

### Tools & Platforms

* VS Code
* GitHub
* Docker
* Arduino IDE
* Power BI

---

# System Architecture

## 🛠️ System Architecture

The complete system is divided into three major components:

### 1. IoT Edge (The Bus)

This layer consists of smart hardware devices installed inside the bus. Raspberry Pi or Arduino controllers manage GPS modules, RFID scanners, cameras, and passenger-counting sensors. Real-time data is collected continuously and transmitted securely to the cloud.

### 2. Cloud Backend

The cloud server processes real-time data streams, stores telemetry information, manages user authentication, and handles route analytics. MQTT or Apache Kafka is used for efficient real-time communication between IoT devices and backend services.

### 3. Client Applications

The system provides a passenger mobile application for real-time ETAs, ticket booking, and live tracking. A separate web dashboard allows fleet managers to monitor buses, analyze occupancy data, and optimize transport operations.

---

# Project Objectives

* To automate bus entry and exit systems
* To improve passenger safety and security
* To reduce manual ticket verification
* To provide real-time monitoring using IoT
* To enhance transport management efficiency
* To enable smart analytics for public transport systems

---

# Advantages

* Faster passenger verification
* Improved security and monitoring
* Reduced human errors
* Real-time tracking and analytics
* Better crowd management
* Efficient transportation system
* Low operational complexity

---

# Applications

* Public transportation systems
* School and college buses
* Smart city transportation
* Employee transportation systems
* Government transport monitoring

---

# Installation & Setup

## 📋 Prerequisites

Before setting up the project, ensure the following software and tools are installed:

* Node.js (v18+) or Python (v3.10+)
* Docker (Optional for containerized database setup)
* Active internet connection for Maps API integration
* MongoDB Database
* MQTT Broker or Apache Kafka setup

---

## 🔧 Setup Instructions

### 1. Clone the Repository

```bash
git clone https://github.com/your-username/next-gen-smart-bus.git
cd next-gen-smart-bus
```

### 2. Environment Configuration

Create a `.env` file in the project root directory and add the following credentials:

```env
PORT=5000
MONGO_URI=mongodb://localhost:27017/smartbus
MAPS_API_KEY=your_api_key_here
MQTT_BROKER_URL=mqtt://broker.hivemq.com
```

### 3. Backend Setup

```bash
cd backend
npm install
npm start
```

Backend server will run at:

```text
http://localhost:5000
```

### 4. Frontend Dashboard Setup

```bash
cd ../frontend
npm install
npm run dev
```

Frontend dashboard will run at:

```text
http://localhost:3000
```

---

# Folder Structure

```text
next-gen-smart-bus/
│
├── static/
├── templates/
├── models/
├── dataset/
├── IoT_Module/
├── database/
├── app.py
├── requirements.txt
└── README.md
```

---

# Future Enhancements

* AI-based behavior analysis
* Voice-enabled smart assistant
* Mobile application integration
* Advanced predictive analytics
* Smart ticketless payment system
* Automatic accident detection system

---

# Screenshots

## Smart Bus Dashboard
![Smart Bus Dashboard](images/dashboard.png)

---

# Results

The system successfully automates passenger entry monitoring and provides real-time tracking, analytics, and smart transportation management using AI and IoT technologies.

---

# Team Members

* Deepak Timlapur
* Chaithanya
* Hemanth
* Sameer

---

# Conclusion

The Next-Gen Smart Bus Entry System using Vision Intelligence and IoT provides an efficient, secure, and automated transportation solution. By integrating AI, computer vision, and IoT technologies, the system improves passenger safety, monitoring, and transport management while supporting future smart city initiatives.

---

# License

This project is developed for academic and educational purposes.

---

# Contact

For queries :

**Deepak Timlapur**
