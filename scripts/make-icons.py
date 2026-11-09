"""앱 아이콘 PNG 생성 (외부 라이브러리 없이). 사용: python3 scripts/make-icons.py"""
import struct, zlib, sys, os

def png(size, path):
    bg, fg, ac = (15, 23, 42), (255, 255, 255), (59, 130, 246)
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            u, v = x / size, y / size
            c = bg
            # 버스 몸체 (둥근 사각형)
            if 0.22 < u < 0.78 and 0.2 < v < 0.72:
                cx = min(abs(u - 0.22), abs(u - 0.78)); cy = min(abs(v - 0.2), abs(v - 0.72))
                r = 0.06
                if not (cx < r and cy < r and (r - cx) ** 2 + (r - cy) ** 2 > r * r):
                    c = fg
                    # 창문
                    if 0.29 < u < 0.71 and 0.28 < v < 0.48:
                        c = ac
            # 바퀴
            for wx in (0.34, 0.66):
                if (u - wx) ** 2 + (v - 0.72) ** 2 < 0.07 ** 2:
                    c = fg if (u - wx) ** 2 + (v - 0.72) ** 2 > 0.035 ** 2 else bg
            row += bytes(c)
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)) + chunk(b"IDAT", raw) + chunk(b"IEND", b"")
    open(path, "wb").write(data)

out = os.path.join(os.path.dirname(__file__), "..", "web")
for s in (180, 192, 512):
    png(s, os.path.join(out, f"icon-{s}.png"))
