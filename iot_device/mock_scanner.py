import time
import requests

API_URL = "http://127.0.0.1:8000"
BUS_ID = "BUS-101"

def simulate_boarding():
    print("==================================================")
    print("🚀 SMART BUS MOCK IOT TERMINAL SIMULATOR")
    print(f"Target API: {API_URL} | Bus ID: {BUS_ID}")
    print("==================================================")
    
    while True:
        print("\nSelect Boarding Simulation Mode:")
        print("1. Simulate Face Recognition Entry (STU-001 - Valid)")
        print("2. Simulate Face Recognition Entry (STU-002 - Unpaid Fees)")
        print("3. Simulate Face Recognition Entry (STU-003 - Wrong Bus)")
        print("4. Simulate QR Code Fallback Scan")
        print("5. Exit Simulator")
        
        choice = input("\nEnter choice (1-5): ").strip()
        
        if choice == "1":
            print("\n[Simulating Camera] Capturing face for Alex Smith (STU-001)...")
            payload = {"bus_id": BUS_ID, "student_id": "STU-001", "mode": "face"}
            try:
                res = requests.post(f"{API_URL}/api/board", json=payload)
                print(f"Response Status: {res.status_code}")
                print(f"Server Response: {res.json()}")
            except Exception as e:
                print(f"Error connecting to backend: {e}")

        elif choice == "2":
            print("\n[Simulating Camera] Capturing face for Jordan Lee (STU-002 - Fee Unpaid)...")
            payload = {"bus_id": BUS_ID, "student_id": "STU-002", "mode": "face"}
            try:
                res = requests.post(f"{API_URL}/api/board", json=payload)
                print(f"Response Status: {res.status_code}")
                print(f"Server Response: {res.json()}")
            except Exception as e:
                print(f"Error connecting to backend: {e}")

        elif choice == "3":
            print("\n[Simulating Camera] Capturing face for Taylor Swift (STU-003 - Wrong Bus)...")
            payload = {"bus_id": BUS_ID, "student_id": "STU-003", "mode": "face"}
            try:
                res = requests.post(f"{API_URL}/api/board", json=payload)
                print(f"Response Status: {res.status_code}")
                print(f"Server Response: {res.json()}")
            except Exception as e:
                print(f"Error connecting to backend: {e}")

        elif choice == "4":
            raw_token = input("Enter raw QR token string (or check MongoDB / Frontend dashboard): ").strip()
            if not raw_token:
                continue
            payload = {"bus_id": BUS_ID, "qr_token": raw_token}
            print(f"\n[Simulating QR Scanner] Scanning token...")
            try:
                res = requests.post(f"{API_URL}/api/qr/scan", json=payload)
                print(f"Response Status: {res.status_code}")
                print(f"Server Response: {res.json()}")
            except Exception as e:
                print(f"Error connecting to backend: {e}")

        elif choice == "5":
            print("Exiting simulator. Have a great day!")
            break
        else:
            print("Invalid choice. Please select 1 through 5.")

if __name__ == "__main__":
    simulate_boarding()
