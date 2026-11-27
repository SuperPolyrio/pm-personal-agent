"""Read the PGL Singapore HUD from a stream of 1280x720 PPM frames."""
import csv
import io
import json
import os
import subprocess
import sys
import time
from PIL import Image

os.environ.setdefault("OMP_THREAD_LIMIT", "1")
origin = sys.stdin.buffer
width, height = 1280, 720
frame_size = width * height * 3


def tile(image, box, threshold, colored=False):
    crop = image.crop(box).convert("HSV" if colored else "RGB")
    pixels = crop.tobytes()
    if colored:
        mask = bytes(
            0 if saturation > 95 and value > 145 and (hue < 38 or 117 < hue < 168) else 255
            for hue, saturation, value in zip(pixels[::3], pixels[1::3], pixels[2::3])
        )
    else:
        mask = bytes(0 if max(pixel) >= threshold else 255
                     for pixel in zip(pixels[::3], pixels[1::3], pixels[2::3]))
    return Image.frombytes("L", crop.size, mask).resize((crop.width * 4, crop.height * 4))


def recognize(canvas, mode, fmt):
    data = io.BytesIO()
    canvas.save(data, "PNG")
    result = subprocess.run(["tesseract", "stdin", "stdout", "--psm", mode, fmt],
                            input=data.getvalue(), capture_output=True, check=True, timeout=3)
    return result.stdout.decode()


def read_hud(image):
    canvas = Image.new("L", (1640, 1470), 255)
    fields = [(489, 32, 544, 57), (548, 25, 605, 75),
              (677, 25, 731, 75), (747, 32, 799, 57)]
    for i, box in enumerate(fields):
        bitmap = tile(image, box, 175 if i in (0, 3) else 138)
        canvas.paste(bitmap, (330 * i + 12, 15 + (200 - bitmap.height) // 2))
    canvas.paste(tile(image, (478, 25, 805, 76), 150), (14, 225))
    for i in range(5):
        base = 97 + 25 * i
        crop = (949, base, 1259, base + 22)
        canvas.paste(tile(image, crop, 0, colored=True), (2, 442 + 102 * i))
        canvas.paste(tile(image, crop, 181), (2, 956 + 102 * i))
    fields = [[] for _ in range(4)]
    banner = []
    kills = [[] for _ in range(10)]
    for row in csv.DictReader(recognize(canvas, "11", "tsv").splitlines(), delimiter="\t", quoting=csv.QUOTE_NONE):
        word = row["text"].strip()
        if not word:
            continue
        x, y = int(row["left"]), int(row["top"]) + int(row["height"]) // 2
        if y < 216 and x < 1320:
            fields[x // 330].append(word)
        elif 225 <= y < 430:
            banner.append(word)
        elif 442 <= y < 952:
            kills[(y - 442) // 102].append((x, word))
        elif 956 <= y < 1466:
            kills[5 + (y - 956) // 102].append((x, word))
    fields = ["".join(words) for words in fields]
    if not (fields[1].isdigit() and fields[2].isdigit()):
        graphic = tile(image, (500, 24, 810, 77), 168)
        banner += [recognize(graphic, "7", "txt").strip()]
    rgb = image.crop((560, 35, 597, 67)).convert("RGB").tobytes()
    red = sum(r > 145 and r > b + 60 for r, b in zip(rgb[::3], rgb[2::3]))
    blue = sum(b > 145 and b > r + 60 for r, b in zip(rgb[::3], rgb[2::3]))
    center = image.crop((623, 31, 658, 71)).convert("RGB").tobytes()
    yellow = sum(r > 155 and g > 98 and r > g + 16 and g > b + 55
                 for r, g, b in zip(center[::3], center[1::3], center[2::3]))
    return {"fields": fields, "banner": " ".join(banner),
            "kills": [[word for _, word in sorted(words)] for words in kills if len(words) >= 2],
            "attackLeft": red > blue, "bomb": yellow >= 140}


if __name__ == "__main__":
    if len(sys.argv) > 1:
        for path in sys.argv[1:]:
            with Image.open(path) as image:
                print(json.dumps(read_hud(image)), flush=True)
    else:
        while origin.readline() == b"P6\n":
            if origin.readline() != b"1280 720\n" or origin.readline() != b"255\n":
                raise ValueError("Expected 1280x720 RGB PPM frames")
            frame = origin.read(frame_size)
            if len(frame) != frame_size:
                break
            at = time.time_ns() // 1_000_000
            print(json.dumps({"at": at, **read_hud(Image.frombytes("RGB", (width, height), frame))}), flush=True)
