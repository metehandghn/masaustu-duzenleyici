// Paketlemeden sonra simgeyi ve program bilgilerini .exe'nin içine yazar.
// electron-builder'ın kendi aracı (winCodeSign) GitHub'dan indirilip Windows'ta
// "symbolic link" hatası verebildiği için npm ile gelen rcedit kullanılıyor.
const path = require('path');
const rcedit = require('rcedit');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const appInfo = context.packager.appInfo;
  const exe = path.join(context.appOutDir, `${appInfo.productFilename}.exe`);
  const icon = path.join(__dirname, 'icon.ico');

  await rcedit(exe, {
    icon,
    'version-string': {
      ProductName: appInfo.productName,
      FileDescription: appInfo.productName,
      CompanyName: 'Metehan Dağhan',
      LegalCopyright: `© ${new Date().getFullYear()} Metehan Dağhan`,
    },
    'file-version': appInfo.version,
    'product-version': appInfo.version,
  });
  console.log('  • simge .exe içine yazıldı', path.basename(exe));
};
