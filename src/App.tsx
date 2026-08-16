// Route split: /upload is the desktop screen (lazy chunk — the only place
// pdfjs may load); everything else is the mobile wallet.
import { lazy, Suspense, useEffect } from 'react';
import { useRoute } from './lib/router';
import { boot } from './lib/store';
import { Toaster } from '@/components/ui/sonner';
import Wallet from './pages/wallet/Wallet';
import BarcodeScreen from './pages/wallet/BarcodeScreen';
import DetailsScreen from './pages/wallet/DetailsScreen';

const Upload = lazy(() => import('./pages/Upload'));

export default function App() {
  const route = useRoute();

  useEffect(() => {
    if (route.name !== 'upload') void boot();
  }, [route.name]);

  return (
    <>
      {(() => {
        switch (route.name) {
          case 'upload':
            return (
              <Suspense fallback={<main className="min-h-screen bg-background" />}>
                <Upload />
              </Suspense>
            );
          case 'barcode':
            return <BarcodeScreen id={route.id} />;
          case 'details':
            return <DetailsScreen id={route.id} />;
          default:
            return <Wallet />;
        }
      })()}
      <Toaster position="bottom-center" />
    </>
  );
}
