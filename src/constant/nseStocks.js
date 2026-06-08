/**
 * NSE Stock Symbol Constants  (ESM)
 * Auto-updated by updateSymbols.js
 *
 * Renames applied:
 *   ZOMATO       -> ETERNAL
 *   TATAMOTORS   -> TMCV  (commercial vehicles post-demerger)
 *   TATAMOTORSDVR-> TMPV  (passenger vehicles post-demerger)
 */

export const LAST_UPDATED = '2026-05-27';

export const SYMBOL_RENAMES = {
  ZOMATO:         'ETERNAL',
  TATAMOTORS:     'TMCV',
  TATAMOTORSDVR:  'TMPV',
  MOTHERSUMIRSYS: 'MOTHERSON',
  MOTHERSUMI:     'MOTHERSON',
  HDFC:           'HDFCBANK',
};

export const NIFTY_50 = [
  'RELIANCE',   'TCS',        'HDFCBANK',   'INFY',       'ICICIBANK',
  'HINDUNILVR', 'ITC',        'SBIN',       'BHARTIARTL', 'KOTAKBANK',
  'LT',         'AXISBANK',   'ASIANPAINT', 'BAJFINANCE', 'MARUTI',
  'WIPRO',      'HCLTECH',    'ULTRACEMCO', 'TITAN',      'SUNPHARMA',
  'NTPC',       'POWERGRID',  'TMCV',       'BAJAJFINSV', 'NESTLEIND',
  'M&M',        'ADANIENT',   'JSWSTEEL',   'TATASTEEL',  'ONGC',
  'COALINDIA',  'TECHM',      'DRREDDY',    'DIVISLAB',   'ADANIPORTS',
  'BPCL',       'HEROMOTOCO', 'CIPLA',      'APOLLOHOSP', 'EICHERMOT',
  'GRASIM',     'HINDALCO',   'INDUSINDBK', 'SBILIFE',    'HDFCLIFE',
  'BRITANNIA',  'BAJAJ-AUTO', 'UPL',        'HAL',        'TATACONSUM',
];

export const NIFTY_NEXT_50 = [
  'ADANIGREEN', 'TMPV',       'AMBUJACEM',  'AUROPHARMA', 'BANDHANBNK',
  'BERGEPAINT', 'BIOCON',     'BOSCHLTD',   'CANBK',      'CHOLAFIN',
  'COLPAL',     'DABUR',      'DLF',        'GAIL',       'GODREJCP',
  'GODREJPROP', 'HAVELLS',    'ICICIGI',    'ICICIPRULI', 'INDIGO',
  'IOC',        'IRCTC',      'JINDALSTEL', 'JUBLFOOD',   'LICI',
  'LUPIN',      'UNITDSPR',   'MOTHERSON',  'MPHASIS',    'MUTHOOTFIN',
  'NAUKRI',     'NMDC',       'PAGEIND',    'PERSISTENT', 'PIIND',
  'PNB',        'RECLTD',     'SAIL',       'SIEMENS',    'SRF',
  'TORNTPHARM', 'TRENT',      'TVSMOTOR',   'UNIONBANK',  'VBL',
  'VEDL',       'VOLTAS',     'ETERNAL',    'ADANIENSOL', 'OFSS',
];

export const NIFTY_MIDCAP_50 = [
  'ABCAPITAL',  'ABFRL',      'ASHOKLEY',   'ASTRAL',     'ATUL',
  'AUBANK',     'BALKRISIND', 'BATAINDIA',  'BHARATFORG', 'BHEL',
  'CANFINHOME', 'COFORGE',    'CONCOR',     'CROMPTON',   'CUB',
  'DIXON',      'ESCORTS',    'FEDERALBNK', 'GNFC',       'GODREJIND',
  'GUJGASLTD',  'HINDPETRO',  'IDFCFIRSTB', 'INDHOTEL',   'INDUSTOWER',
  'JKCEMENT',   'JSWENERGY',  'KAYNES',     'KPITTECH',   'LALPATHLAB',
  'LICHSGFIN',  'LTTS',       'M&MFIN',     'MANAPPURAM', 'MARICO',
  'MAXHEALTH',  'METROPOLIS', 'NHPC',       'OBEROIRLTY', 'PETRONET',
  'PHOENIXLTD', 'POLYCAB',    'SYNGENE',    'FLUOROCHEM', 'HONAUT',
  'NATIONALUM', 'MRPL',       'HFCL',       'WHIRLPOOL',  'MFSL',
];

export const BANK_NIFTY = [
  'HDFCBANK', 'ICICIBANK', 'KOTAKBANK',  'AXISBANK',   'SBIN',
  'INDUSINDBK', 'BANDHANBNK', 'FEDERALBNK', 'PNB',    'CANBK',
  'IDFCFIRSTB', 'AUBANK',
];

export const NIFTY_IT = [
  'TCS', 'INFY', 'WIPRO', 'HCLTECH', 'TECHM',
  'MPHASIS', 'LTTS', 'COFORGE', 'PERSISTENT', 'OFSS',
];

export const NIFTY_PHARMA = [
  'SUNPHARMA', 'DRREDDY', 'CIPLA',  'DIVISLAB',   'LUPIN',
  'AUROPHARMA', 'TORNTPHARM', 'ALKEM', 'BIOCON', 'GLENMARK',
];

export const NIFTY_AUTO = [
  'MARUTI', 'BAJAJ-AUTO', 'HEROMOTOCO', 'EICHERMOT', 'TVSMOTOR',
  'ASHOKLEY', 'TMCV', 'TMPV', 'M&M', 'ESCORTS',
  'MOTHERSON', 'BHARATFORG', 'BALKRISIND', 'CEATLTD', 'SONACOMS',
];

export const FNO_STOCKS = [
  // Banking & Finance
  'HDFCBANK',   'ICICIBANK',  'KOTAKBANK',  'AXISBANK',   'SBIN',
  'INDUSINDBK', 'BANDHANBNK', 'FEDERALBNK', 'PNB',        'CANBK',
  'IDFCFIRSTB', 'AUBANK',     'YESBANK',    'BANKBARODA', 'UNIONBANK',
  'CENTRALBK',  'UCOBANK',    'IDBI',       'RBLBANK',    'KARURVYSYA',
  'CUB',        'EQUITASBNK', 'J&KBANK',
  // NBFC
  'BAJFINANCE', 'BAJAJFINSV', 'MUTHOOTFIN', 'MANAPPURAM', 'CHOLAFIN',
  'M&MFIN',     'LICHSGFIN',  'SHRIRAMFIN', 'PNBHOUSING', 'CANFINHOME',
  'ABCAPITAL',  'RECLTD',     'PFC',        'IRFC',       'IIFL',
  'JMFINANCIL', 'MOTILALOFS', 'ANGELONE',   'ISEC',
  // Insurance
  'SBILIFE',    'HDFCLIFE',   'ICICIGI',    'ICICIPRULI', 'STARHEALTH',
  'MFSL',       'NIACL',      'GICRE',
  // Asset Management
  'HDFCAMC',    'UTIAMC',     'CAMS',       'MCX',        'IEX',
  // IT
  'TCS',        'INFY',       'WIPRO',      'HCLTECH',    'TECHM',
  'MPHASIS',    'LTTS',       'COFORGE',    'PERSISTENT', 'OFSS',
  'KPITTECH',   'ZENSARTECH', 'HAPPSTMNDS', 'BSOFT',      'NAUKRI',
  'LATENTVIEW', 'MAPMYINDIA', 'TANLA',      'INTELLECT',
  // Telecom
  'BHARTIARTL', 'IDEA',       'TATACOMM',   'STLTECH',    'HFCL',
  'RAILTEL',    'ITI',
  // Automobiles
  'MARUTI',     'BAJAJ-AUTO', 'HEROMOTOCO', 'EICHERMOT',  'TVSMOTOR',
  'ASHOKLEY',   'TMCV',       'TMPV',       'M&M',        'ESCORTS',
  'MOTHERSON',  'BHARATFORG', 'BALKRISIND', 'CEATLTD',    'JKTYRE',
  'SONACOMS',   'JTEKTINDIA', 'SUPRAJIT',
  // Capital Goods
  'LT',         'BEL',        'BHEL',       'HAL',        'SIEMENS',
  'ABB',        'CGPOWER',    'CUMMINSIND', 'BEML',       'GRINDWELL',
  'ELGIEQUIP',  'KALPATPOWR', 'KEC',        'PATELENG',   'ENGINERSIN',
  'TITAGARH',   'ISGEC',      'CRAFTSMAN',  'MIDHANI',    'DATAPATTNS',
  // Energy
  'RELIANCE',   'ONGC',       'BPCL',       'IOC',        'HINDPETRO',
  'GAIL',       'PETRONET',   'TATAPOWER',  'ADANIGREEN', 'ADANIENSOL',
  'ADANIPOWER', 'TORNTPOWER', 'NTPC',       'POWERGRID',  'JPPOWER',
  'SUZLON',     'NHPC',       'SJVN',       'RPOWER',     'SWSOLAR',
  // Metals
  'JSWSTEEL',   'TATASTEEL',  'HINDALCO',   'VEDL',       'SAIL',
  'NMDC',       'HINDCOPPER', 'HINDZINC',   'NATIONALUM', 'APLAPOLLO',
  'RATNAMANI',  'WELCORP',    'RKFORGE',
  // Cement
  'ULTRACEMCO', 'SHREECEM',   'GRASIM',     'AMBUJACEM',  'ACC',
  'RAMCOCEM',   'JKCEMENT',   'NUVOCO',     'DALMIACEM',
  // Pharma
  'SUNPHARMA',  'DRREDDY',    'CIPLA',      'DIVISLAB',   'LUPIN',
  'AUROPHARMA', 'TORNTPHARM', 'ALKEM',      'BIOCON',     'GLENMARK',
  'LALPATHLAB', 'METROPOLIS', 'THYROCARE',  'SYNGENE',    'JBCHEPHARM',
  'GLAXO',      'ABBOTINDIA', 'SEQUENT',    'LAURUSLABS', 'MARKSANS',
  'WINDLAS',    'AJANTPHARM',
  // FMCG
  'HINDUNILVR', 'ITC',        'BRITANNIA',  'NESTLEIND',  'DABUR',
  'MARICO',     'EMAMILTD',   'COLPAL',     'GODREJCP',   'TATACONSUM',
  'RADICO',     'VBL',        'JUBLFOOD',   'DEVYANI',    'VSTIND',
  'AVANTIFEED', 'PGHH',       'GILLETTE',   'SANOFI',
  // Chemicals
  'PIDILITIND', 'DEEPAKNTR',  'AARTIIND',   'ALKYLAMINE', 'FINEORG',
  'SUDARSCHEM', 'NOCIL',      'CHAMBLFERT', 'GHCL',       'GSFC',
  'DEEPAKFERT', 'CLEAN',      'EIDPARRY',   'BALAMINES',  'SUMICHEM',
  'HIKAL',      'RALLIS',     'TATACHEM',   'SOLARA',     'INDIGOPNTS',
  'KANSAINER',  'AEGISCHEM',  'GALAXYSURF',
  // Real Estate
  'DLF',        'GODREJPROP', 'OBEROIRLTY', 'PHOENIXLTD', 'BRIGADE',
  'IBREALEST',  'OMAXE',      'KOLTEPATIL', 'MAXESTATES', 'MAHLIFE',
  // Consumer Durables
  'TITAN',      'VOLTAS',     'HAVELLS',    'POLYCAB',    'WHIRLPOOL',
  'CROMPTON',   'DIXON',      'AMBER',      'BLUESTARCO', 'SYMPHONY',
  'ORIENTELEC', 'NILKAMAL',   'RELAXO',     'BATAINDIA',  'TTKPRESTIG',
  'KAYNES',     'SAFARI',
  // Retail
  'DMART',      'TRENT',      'ABFRL',      'TCNSBRANDS', 'VMART',
  'WESTLIFE',   'PVRINOX',    'LEMONTREE',  'INDHOTEL',
  // Media / Logistics
  'SUNTV',      'ZEEL',       'INDIGO',     'DELHIVERY',  'CONCOR',
  'RITES',      'SNOWMAN',
  // Agri
  'KRBL',       'BALRAMCHIN', 'GODREJAGRO', 'JKPAPER',    'TNPL',
  // PSU / New-age
  'GMRINFRA',   'IRCTC',      'CARERATING', 'CRISIL',     'ETERNAL',
  'POLICYBZR',  'PAYTM',      'EASEMYTRIP', 'ECLERX',     'TEAMLEASE',
  'ROUTE',      'SAPPHIRE',   'MEDANTA',    'KIMS',       'CONCORDBIO',
  'MTAR',       'STCINDIA',   'REDINGTON',  'NESCO',      'SCHAEFFLER',
  'SKFINDIA',   'TIMKEN',     'WABCOINDIA', 'LINDEINDIA', 'CASTROLIND',
  'EXIDEIND',   'SUNDARMFIN', 'MANINFRA',   'KNRCON',
];

function dedup(arr) { return [...new Set(arr)]; }

export const NIFTY_100         = dedup([...NIFTY_50, ...NIFTY_NEXT_50]);
export const NIFTY_150         = dedup([...NIFTY_100, ...NIFTY_MIDCAP_50]);
export const ALL_OPTION_STOCKS = dedup([
  ...NIFTY_150, ...BANK_NIFTY, ...NIFTY_IT,
  ...NIFTY_PHARMA, ...NIFTY_AUTO, ...FNO_STOCKS,
]);
