/* poll() stub for the VLC plugin build: mingw-w64 ships no poll.h and the
   VLC sdk headers reference poll() from an inline helper that this plugin
   never executes (the VLC core uses its own networking). */
struct pollfd { int fd; short events; short revents; };

int poll(struct pollfd *fds, unsigned nfds, int timeout)
{
    (void)fds; (void)nfds; (void)timeout;
    return -1;
}
