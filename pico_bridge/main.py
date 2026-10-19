# WiFi <-> UART bridge on a Raspberry Pi Pico W, standing in for the mBot's Bluetooth module.
#
#   mBot socket P5 (former BT module)        Pico W
#   pin 1  5V   ---------------------------  VSYS (pin 39)
#   pin 2  GND  ---------------------------  GND  (pin 38)
#   pin 3  RX (D0) <--[1k]-----------------  GP0 = UART0 TX (pin 1)
#   pin 4  TX (D1) --[1k]--+---------------  GP1 = UART0 RX (pin 2)    5 V -> 3.3 V divider:
#                          +--[2k]-- GND                                the Pico's pins are not 5 V tolerant
#
# The PC connects with TCP to port 2323 and gets the raw serial line (115200 baud).
# It finds the Pico by broadcasting "MBOT?" to UDP port 2324; the Pico answers "MBOT <ip> 2323".
# LED: fast blink = joining WiFi, slow blink = waiting for the PC, on = PC connected.
# WiFi name/password live in wifi_config.py (SSID = "...", PASSWORD = "...").

import asyncio
import socket
import time

import machine
import network
import rp2

import wifi_config

TCP_PORT = 2323
DISCOVERY_PORT = 2324

uart = machine.UART(0, 115200, tx=machine.Pin(0), rx=machine.Pin(1), rxbuf=2048)
led = machine.Pin("LED", machine.Pin.OUT)
wlan = network.WLAN(network.STA_IF)
state = {"blink_ms": 100, "client": None}


async def blink():
    while True:
        if state["blink_ms"]:
            led.toggle()
            await asyncio.sleep_ms(state["blink_ms"])
        else:
            led.on()
            await asyncio.sleep_ms(100)


async def keep_wifi():
    rp2.country(getattr(wifi_config, "COUNTRY", "DE"))
    network.hostname("mbot")
    wlan.active(True)
    wlan.config(pm=getattr(network.WLAN, "PM_NONE", 0xA11140))   # no power saving: lower latency
    while True:
        if not wlan.isconnected():
            state["blink_ms"] = 100
            wlan.connect(wifi_config.SSID, wifi_config.PASSWORD)
            for _ in range(40):
                if wlan.isconnected():
                    break
                await asyncio.sleep_ms(250)
            if wlan.isconnected():
                print("WiFi ok:", wlan.ifconfig()[0])
                state["blink_ms"] = 0 if state["client"] else 600
            else:
                print("WiFi failed, status", wlan.status())
        await asyncio.sleep(2)


async def discovery():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("0.0.0.0", DISCOVERY_PORT))
    s.setblocking(False)
    while True:
        try:
            data, addr = s.recvfrom(64)
            if data.strip() == b"MBOT?" and wlan.isconnected():
                s.sendto("MBOT {} {}".format(wlan.ifconfig()[0], TCP_PORT).encode(), addr)
        except OSError:
            pass
        await asyncio.sleep_ms(50)


async def client(reader, writer):
    old = state["client"]
    if old:                              # newest PC wins
        try:
            old.close()
        except Exception:
            pass
    state["client"] = writer
    state["blink_ms"] = 0
    print("PC connected")
    uart.read()                          # drop stale bytes

    async def uart_to_pc():
        while state["client"] is writer:
            n = uart.any()
            if n:
                writer.write(uart.read(n))
                await writer.drain()
            else:
                await asyncio.sleep_ms(2)

    pump = asyncio.create_task(uart_to_pc())
    try:
        while True:
            data = await reader.read(256)
            if not data:
                break
            uart.write(data)
    except Exception:
        pass
    finally:
        if state["client"] is writer:
            state["client"] = None
            state["blink_ms"] = 600
        pump.cancel()
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass
        print("PC disconnected")


async def main():
    asyncio.create_task(blink())
    asyncio.create_task(keep_wifi())
    asyncio.create_task(discovery())
    await asyncio.start_server(client, "0.0.0.0", TCP_PORT)
    while True:
        await asyncio.sleep(10)


time.sleep_ms(300)
asyncio.run(main())
