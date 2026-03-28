const { registerFont } = require('canvas');
const fs = require('fs');
const path = require('path');
const FONTS = [
  ['Impact',          'fonts/Impact.ttf'],
  ['Anton',           'fonts/Anton-Regular.ttf'],
  ['BebasNeue',       'fonts/BebasNeue-Regular.ttf'],
  ['BebasNeueBold',   'fonts/BebasNeue-Bold.ttf'],
  ['Oswald',          'fonts/Oswald-Bold.ttf'],
  ['BarlowCondensed', 'fonts/BarlowCondensed-Bold.ttf'],
  ['FjallaOne',       'fonts/FjallaOne-Regular.ttf'],
  ['Roboto',          'fonts/Roboto-Bold.ttf'],
  ['Poppins',         'fonts/Poppins-Bold.ttf'],
  ['Lato',            'fonts/Lato-Bold.ttf'],
  ['Ubuntu',          'fonts/Ubuntu-Bold.ttf'],
  ['Bangers',         'fonts/Bangers-Regular.ttf'],
  ['Pacifico',        'fonts/Pacifico-Regular.ttf'],
  ['PermanentMarker', 'fonts/PermanentMarker-Regular.ttf'],
  ['Righteous',       'fonts/Righteous-Regular.ttf'],
  ['Montserrat',      'fonts/Montserrat-Bold.ttf'],
  ['CaptionFont',     'DejaVuSans-Bold.ttf'],
  ['Exo2',            'fonts/Exo2-Bold.ttf'],
  ['Raleway',         'fonts/Raleway-Bold.ttf'],
  ['Nunito',          'fonts/Nunito-Bold.ttf'],
  ['Teko',            'fonts/Teko-Bold.ttf'],
  ['FredokaOne',      'fonts/FredokaOne-Regular.ttf'],
  ['Liberation',      'fonts/LiberationSans-Bold.ttf'],
];
for (const [family, file] of FONTS) {
  const p = path.join('/Users/kanemcgregor/dubshorts', file);
  if (!fs.existsSync(p)) { console.log('MISSING:', file); continue; }
  try { registerFont(p, { family, weight: 'bold' }); console.log('OK:', family); }
  catch(e) { console.log('FAIL:', family, '-', e.message); }
}
