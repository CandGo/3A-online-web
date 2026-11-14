# STUN 探测(WSL 鉴别诊断用):同一物理网络,绕过 Windows 用户态/WFP 驱动路径
import socket, os, struct, zlib, sys

def crc32_fp(msg):
    return (zlib.crc32(msg) ^ 0x5354554E) & 0xFFFFFFFF

def probe(host, port, timeout=3.0):
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(timeout)
        txid = os.urandom(12)
        body = struct.pack('!HHI', 0x0001, 8, 0x2112A442) + txid  # len 占位=8(带FINGERPRINT)
        body = body[:2] + struct.pack('!H', 8) + body[4:]  # 重打包保持长度字段
        fp = struct.pack('!HHI', 0x8028, 4, crc32_fp(body))
        msg = body + fp
        s.sendto(msg, (host, port))
        buf, _ = s.recvfrom(2048)
        if len(buf) >= 20 and struct.unpack('!H', buf[:2])[0] == 0x0101:
            # 解析 XOR-MAPPED-ADDRESS
            off = 20
            while off + 4 <= len(buf):
                at, ln = struct.unpack('!HH', buf[off:off+4])
                if at == 0x0020 and ln >= 8:
                    xport = struct.unpack('!H', buf[off+6:off+8])[0] ^ 0x2112
                    xip = struct.unpack('!I', buf[off+8:off+12])[0] ^ 0x2112A442
                    ip = '.'.join(str((xip >> s2) & 255) for s2 in (24, 16, 8, 0))
                    return f'OK   {host}:{port}  映射={ip}:{xport}'
                off += 4 + ln + (ln % 4 and 4 - ln % 4)
            return f'OK   {host}:{port}  (无XOR-MAPPED-ADDRESS)'
        return f'RESP {host}:{port}  非成功响应 type=0x{struct.unpack("!H", buf[:2])[0]:04x}'
    except socket.timeout:
        return f'FAIL {host}:{port}  (timeout)'
    except Exception as e:
        return f'FAIL {host}:{port}  ({e})'

targets = sys.argv[1:] or ['stun.chat.bilibili.com:3478', 'stun.miwifi.com:3478', 'global.stun.twilio.com:3478']
for t in targets:
    h, p = t.rsplit(':', 1)
    print(probe(h, int(p)))
