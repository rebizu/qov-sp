/* fs_sad.c — per-frame RGBA SAD against the previous frame, for the §3b
 * frame-skip analysis. stdin: raw RGBA frames. stdout: "n sad" per frame
 * (frame 0 SAD = 0). */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>

int main(int argc, char **argv)
{
    if (argc < 3) { fprintf(stderr, "args: W H\n"); return 1; }
    int w = atoi(argv[1]), h = atoi(argv[2]);
    size_t fb = (size_t)w * h * 4;
    uint8_t *prev = malloc(fb), *cur = malloc(fb);
    if (!prev || !cur || fread(prev, 1, fb, stdin) != fb) return 1;
    long n = 0;
    printf("0 0\n");
    while (fread(cur, 1, fb, stdin) == fb) {
        long long sad = 0;
        for (size_t i = 0; i < fb; i += 4)
            sad += abs(cur[i] - prev[i]) + abs(cur[i+1] - prev[i+1]) +
                   abs(cur[i+2] - prev[i+2]);
        printf("%ld %lld\n", ++n, sad);
        uint8_t *t = prev; prev = cur; cur = t;
    }
    return 0;
}
