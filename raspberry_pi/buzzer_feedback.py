"""Platform-aware recognition feedback: PC speaker or Raspberry Pi GPIO."""
import logging
import os
import sys
import time

logger = logging.getLogger("SmartBusIoT.Buzzer")


class BuzzerFeedback:
    def __init__(self):
        self._winsound = None
        self._gpio_buzzer = None
        self._gpio = None
        if sys.platform == "win32":
            try:
                import winsound
                self._winsound = winsound
            except ImportError:
                logger.warning("Windows speaker feedback unavailable")
        else:
            pin = int(os.environ.get("SMARTBUS_BUZZER_GPIO", "18"))
            try:
                from gpiozero import Buzzer
                self._gpio_buzzer = Buzzer(pin)
            except Exception:
                try:
                    import RPi.GPIO as GPIO
                    GPIO.setmode(GPIO.BCM)
                    GPIO.setup(pin, GPIO.OUT, initial=GPIO.LOW)
                    self._gpio = (GPIO, pin)
                except Exception:
                    logger.warning("GPIO buzzer unavailable; configure gpiozero/RPi.GPIO and wiring")

    def beep(self, count: int):
        count = max(1, min(int(count), 3))
        for index in range(count):
            try:
                if self._winsound:
                    self._winsound.Beep(1000, 120)
                elif self._gpio_buzzer:
                    self._gpio_buzzer.on()
                    time.sleep(0.12)
                    self._gpio_buzzer.off()
                elif self._gpio:
                    gpio, pin = self._gpio
                    gpio.output(pin, gpio.HIGH)
                    time.sleep(0.12)
                    gpio.output(pin, gpio.LOW)
            except Exception as exc:
                logger.warning("Buzzer output failed: %s", exc)
            if index < count - 1:
                time.sleep(0.12)
