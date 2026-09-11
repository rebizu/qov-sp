/* Include BEFORE any vlc_*.h: vlc_threads.h (Windows path) calls poll()
   without a declaration and mingw-w64 ships no poll.h. */
#ifndef QOV_PRE_H
#define QOV_PRE_H
struct pollfd;
int poll(struct pollfd *fds, unsigned nfds, int timeout);
#endif
