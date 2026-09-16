s = open('qov_v2.h').read()
old_g = "static int g_profile_on;"
assert s.count(old_g) == 1
s = s.replace(old_g, """static int g_profile_on;
static long g2_chain, g2_qp, g2_dc, g2_acrun, g2_lev, g2_eob;""", 1)
old = """    if (v2) {
        while (*skip >= 255) { qov__buf_u8(&e->fb, 255); *skip -= 255; }
        qov__buf_u8(&e->fb, (uint8_t)*skip);
        *skip = 0;
        return;
    }"""
assert s.count(old) == 1
s = s.replace(old, """    if (v2) {
        while (*skip >= 255) { qov__buf_u8(&e->fb, 255); *skip -= 255; g2_chain++; }
        qov__buf_u8(&e->fb, (uint8_t)*skip);
        g2_chain++;
        *skip = 0;
        return;
    }""", 1)
old = "    if (v2) qov__buf_u8(&e->fb, (uint8_t)(0x40 + (int)e->dct_qp - (int)e->dct_qp_base));"
assert s.count(old) == 1
s = s.replace(old, old + " g2_qp++;", 1)
old = """    qov__buf_u16(&e->fb, (uint16_t)((uint16_t)qv[0] & 0xffff));
    g_blocks++;"""
assert s.count(old) == 1
s = s.replace(old, """    qov__buf_u16(&e->fb, (uint16_t)((uint16_t)qv[0] & 0xffff));
    if (bare) g2_dc += 2;
    g_blocks++;""", 1)
old = """            while (zero_run >= 16) { qov__buf_u8(&e->fb, 0xF0); zero_run -= 16; }
            int size = (qv[k] >= -128 && qv[k] <= 127) ? 1 : (qv[k] >= -32768 && qv[k] <= 32767) ? 2
                     : (qv[k] >= -8388608 && qv[k] <= 8388607) ? 3 : 4;
            qov__buf_u8(&e->fb, (uint8_t)((zero_run << 4) | size));"""
assert s.count(old) == 1
s = s.replace(old, """            while (zero_run >= 16) { qov__buf_u8(&e->fb, 0xF0); zero_run -= 16; if (bare) g2_acrun++; }
            int size = (qv[k] >= -128 && qv[k] <= 127) ? 1 : (qv[k] >= -32768 && qv[k] <= 32767) ? 2
                     : (qv[k] >= -8388608 && qv[k] <= 8388607) ? 3 : 4;
            qov__buf_u8(&e->fb, (uint8_t)((zero_run << 4) | size));
            if (bare) { g2_acrun++; g2_lev += size; }""", 1)
old = """        qov__buf_u8(&e->fb, 0x00);
    }
    rec[0] = (float)(qv[0] * quant[0] / scale);"""
assert s.count(old) == 1
s = s.replace(old, """        qov__buf_u8(&e->fb, 0x00);
        if (bare) g2_eob++;
    }
    rec[0] = (float)(qv[0] * quant[0] / scale);""", 1)
open('qov_v2.h','w').write(s)
print("counters ok")
