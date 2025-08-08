function parseM3U(text) {
  if (!text || typeof text !== 'string') return [];
  
  const lines = text.split(/\r?\n/);
  const playlist = [];
  let currentChannel = {};

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith('#EXTINF:')) {
      const info = trimmedLine.substring(8).trim();
      const titleMatch = info.match(/,(.+)$/);
      const title = titleMatch ? titleMatch[1] : '';

      const getAttribute = (name) => {
        const match = info.match(new RegExp(`${name}="([^"]+)"`, 'i'));
        return match ? match[1] : '';
      };

      currentChannel = {
        title,
        logo: getAttribute('tvg-logo'),
        id: getAttribute('tvg-id'),
        group: getAttribute('group-title'),
        url: '',
      };
    } else if (trimmedLine && !trimmedLine.startsWith('#')) {
      currentChannel.url = trimmedLine;
      if (currentChannel.title && currentChannel.url) {
        playlist.push(currentChannel);
      }
      currentChannel = {};
    }
  }

  return playlist;
}

module.exports = { parseM3U };
