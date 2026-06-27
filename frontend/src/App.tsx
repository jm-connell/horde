import { Route, Routes } from "react-router-dom";
import Library from "./pages/Library";
import History from "./pages/History";
import Download from "./pages/Download";
import Review from "./pages/Review";
import Watch from "./pages/Watch";
import Settings from "./pages/Settings";
import Playlists from "./pages/Playlists";
import PlaylistDetail from "./pages/PlaylistDetail";
import TopNav from "./components/TopNav";
import { PlaybackProvider } from "./context/PlaybackContext";
import { DownloadProvider } from "./context/DownloadContext";

export default function App() {
  return (
    <DownloadProvider>
      <PlaybackProvider>
        <div className="min-h-full overflow-x-hidden">
          <TopNav />
          <main className="mx-auto max-w-[1600px] px-3 py-6 md:px-6">
            <Routes>
              <Route path="/" element={<Library />} />
              <Route path="/history" element={<History />} />
              <Route path="/download" element={<Download />} />
              <Route path="/playlists" element={<Playlists />} />
              <Route path="/playlists/:id" element={<PlaylistDetail />} />
              <Route path="/review" element={<Review />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/watch/:id" element={<Watch />} />
            </Routes>
          </main>
        </div>
      </PlaybackProvider>
    </DownloadProvider>
  );
}
