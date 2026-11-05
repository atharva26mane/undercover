'use strict';
// Word pairs for Undercover. Each pair = two similar-but-different things.
// One word goes to the Civilians, the other to the Undercover (randomly swapped each game).
// Basic -> intermediate difficulty. Add your own at the bottom; keep every pair "close but not identical".
module.exports = [
  // Nature & weather
  ['sea', 'ocean'], ['river', 'stream'], ['lake', 'pond'], ['mountain', 'hill'],
  ['volcano', 'geyser'], ['waterfall', 'fountain'], ['desert', 'beach'], ['forest', 'jungle'],
  ['island', 'peninsula'], ['cave', 'tunnel'], ['rain', 'drizzle'], ['thunder', 'lightning'],
  ['storm', 'hurricane'], ['fog', 'cloud'], ['snow', 'ice'], ['rainbow', 'sunset'],
  ['moon', 'sun'], ['star', 'planet'], ['comet', 'meteor'], ['earthquake', 'tsunami'],
  ['flood', 'drought'], ['wind', 'breeze'], ['fire', 'lava'], ['smoke', 'steam'],
  ['sand', 'dust'], ['shadow', 'reflection'],

  // Animals
  ['whale', 'shark'], ['dolphin', 'seal'], ['lion', 'tiger'], ['leopard', 'cheetah'],
  ['wolf', 'fox'], ['horse', 'donkey'], ['camel', 'llama'], ['cow', 'buffalo'],
  ['goat', 'sheep'], ['rabbit', 'hare'], ['mouse', 'rat'], ['crow', 'pigeon'],
  ['eagle', 'vulture'], ['owl', 'bat'], ['peacock', 'parrot'], ['frog', 'toad'],
  ['crocodile', 'alligator'], ['snake', 'eel'], ['butterfly', 'moth'], ['bee', 'wasp'],
  ['ant', 'termite'], ['spider', 'scorpion'], ['crab', 'lobster'], ['octopus', 'squid'],
  ['turtle', 'tortoise'], ['monkey', 'gorilla'], ['elephant', 'rhino'], ['penguin', 'duck'],
  ['hen', 'turkey'], ['deer', 'antelope'],

  // Food & drink
  ['tea', 'coffee'], ['milk', 'curd'], ['butter', 'cheese'], ['bread', 'chapati'],
  ['rice', 'noodles'], ['pizza', 'burger'], ['samosa', 'pakora'], ['biryani', 'pulao'],
  ['dosa', 'pancake'], ['sandwich', 'wrap'], ['chocolate', 'toffee'], ['ice cream', 'kulfi'],
  ['cake', 'pastry'], ['cookie', 'biscuit'], ['juice', 'smoothie'], ['soda', 'lemonade'],
  ['honey', 'jam'], ['sugar', 'salt'], ['pepper', 'chilli'], ['mango', 'papaya'],
  ['apple', 'pear'], ['orange', 'lemon'], ['grapes', 'cherry'], ['watermelon', 'pumpkin'],
  ['potato', 'tomato'], ['onion', 'garlic'], ['carrot', 'radish'], ['spinach', 'cabbage'],
  ['egg', 'omelette'], ['soup', 'curry'], ['popcorn', 'chips'], ['jalebi', 'gulab jamun'],
  ['momo', 'dumpling'], ['cappuccino', 'latte'], ['pasta', 'macaroni'], ['peanut', 'almond'],

  // Everyday objects
  ['pen', 'pencil'], ['book', 'diary'], ['bag', 'suitcase'], ['wallet', 'purse'],
  ['watch', 'bracelet'], ['ring', 'necklace'], ['glasses', 'sunglasses'], ['umbrella', 'raincoat'],
  ['shoes', 'sandals'], ['socks', 'gloves'], ['shirt', 'jacket'], ['jeans', 'trousers'],
  ['cap', 'helmet'], ['scarf', 'shawl'], ['towel', 'blanket'], ['pillow', 'cushion'],
  ['bed', 'sofa'], ['chair', 'stool'], ['table', 'desk'], ['mirror', 'window'],
  ['door', 'gate'], ['lamp', 'torch'], ['candle', 'lantern'], ['key', 'lock'],
  ['knife', 'scissors'], ['spoon', 'fork'], ['plate', 'bowl'], ['cup', 'glass'],
  ['bottle', 'jug'], ['kettle', 'pressure cooker'], ['fridge', 'freezer'], ['fan', 'air conditioner'],
  ['heater', 'geyser'], ['mop', 'broom'], ['soap', 'shampoo'], ['toothbrush', 'comb'],
  ['razor', 'trimmer'], ['perfume', 'deodorant'], ['rope', 'chain'], ['ladder', 'stairs'],
  ['hammer', 'axe'], ['nail', 'screw'], ['glue', 'tape'], ['bucket', 'tub'],
  ['coin', 'medal'], ['gold', 'silver'], ['diamond', 'crystal'], ['flag', 'banner'],
  ['balloon', 'bubble'], ['tent', 'hut'], ['injection', 'tablet'],

  // Tech & machines
  ['phone', 'tablet'], ['laptop', 'desktop'], ['keyboard', 'piano'], ['mouse', 'remote'],
  ['camera', 'binoculars'], ['headphones', 'earphones'], ['speaker', 'microphone'],
  ['charger', 'power bank'], ['television', 'projector'], ['printer', 'scanner'],
  ['wifi', 'bluetooth'], ['email', 'message'], ['robot', 'drone'], ['battery', 'solar panel'],
  ['turbine', 'windmill'], ['generator', 'engine'], ['bulb', 'tube light'], ['clock', 'alarm'],

  // Transport
  ['car', 'taxi'], ['bus', 'train'], ['bike', 'scooter'], ['cycle', 'rickshaw'],
  ['plane', 'helicopter'], ['ship', 'boat'], ['submarine', 'ferry'], ['metro', 'tram'],
  ['truck', 'tractor'], ['rocket', 'missile'], ['bridge', 'flyover'], ['road', 'highway'],
  ['airport', 'railway station'], ['parachute', 'paraglider'],

  // Places
  ['school', 'college'], ['hospital', 'clinic'], ['library', 'bookstore'], ['museum', 'gallery'],
  ['hotel', 'hostel'], ['mall', 'market'], ['bank', 'ATM'], ['cinema', 'theatre'],
  ['stadium', 'gym'], ['park', 'garden'], ['zoo', 'aquarium'], ['farm', 'orchard'],
  ['castle', 'palace'], ['tower', 'lighthouse'], ['pyramid', 'skyscraper'], ['village', 'city'],
  ['prison', 'fort'], ['kitchen', 'canteen'],

  // Jobs & people
  ['doctor', 'nurse'], ['teacher', 'professor'], ['police', 'soldier'], ['chef', 'waiter'],
  ['pilot', 'driver'], ['farmer', 'gardener'], ['thief', 'robber'], ['actor', 'singer'],
  ['painter', 'sculptor'], ['lawyer', 'judge'], ['king', 'emperor'], ['magician', 'clown'],
  ['engineer', 'architect'], ['barber', 'tailor'], ['scientist', 'inventor'], ['detective', 'spy'],

  // Fun, sports & hobbies
  ['cricket', 'baseball'], ['football', 'rugby'], ['tennis', 'badminton'], ['chess', 'ludo'],
  ['carrom', 'pool'], ['kabaddi', 'wrestling'], ['swimming', 'diving'], ['running', 'jogging'],
  ['yoga', 'meditation'], ['guitar', 'violin'], ['drum', 'tabla'], ['movie', 'series'],
  ['song', 'poem'], ['cartoon', 'comic'], ['cards', 'dice'], ['kite', 'balloon'],
  ['camping', 'trekking'], ['fishing', 'hunting'], ['magic', 'illusion'], ['circus', 'carnival'],

  // ---- Desi memes & internet culture (researched Nov 2026) ----
  ['Jaldi the late', 'Home from work'],        // Ravi Kishan's viral slips
  ['Ravi Kishan', 'Pankaj Tripathi'],
  ['Binod', 'Bhupendra Jogi'],                 // random names the internet made famous
  ['Moye Moye', 'Bado Badi'],                  // viral meme songs
  ['Chin Tapak Dum Dum', 'Abra Ka Dabra'],     // magic spells (Chhota Bheem villain meme)
  ['Mogambo', 'Gabbar'],
  ['Jethalal', 'Babu Bhaiya'],
  ['Kokilaben', 'Gopi Bahu'],                  // "Rasode mein kaun tha"
  ['Munna Bhaiya', 'Kaleen Bhaiya'],           // Mirzapur
  ['Sachiv ji', 'Pradhan ji'],                 // Panchayat
  ['Panchayat', 'Gullak'],
  ['Hera Pheri', 'Golmaal'],
  ['Waah Shampy Waah', 'Malik galti ho gayi'], // 2025 viral clips
  ['6-7', 'Skibidi'],                          // Gen Alpha nonsense
  ['Vishal Mega Mart', 'D-Mart'],              // + the "guard exam" meme
  ['Studio Ghibli', 'Nano Banana'],            // AI photo trends
  ["India's Got Latent", 'Shark Tank India'],
  ['Dhurandhar', 'Animal'],
  ['Pushpa', 'Rocky Bhai'],
  ['Shaktimaan', 'Chhota Bheem'],
  ['Doraemon', 'Shinchan'],
  ['CarryMinati', 'BB Ki Vines'],
  ['Sigma', 'Alpha'],
  ['Rizz', 'Aura'],
  ['Delulu', 'Main character'],
  ['Pookie', 'Babu Shona'],

  // ---- Hindi / Hinglish slang ----
  ['Chapri', 'Tapori'],
  ['Kalesh', 'Lafda'],
  ['Bawaal', 'Bhasad'],
  ['Jugaad', 'Setting'],
  ['Jhakaas', 'Kadak'],
  ['Bindaas', 'Mast'],
  ['Faltu', 'Bakwaas'],
  ['Bakaiti', 'Gappe'],
  ['Ghanta', 'Thenga'],
  ['Bhai', 'Yaar'],
  ['Jalwa', 'Swag'],
  ['Chillar', 'Note'],
  ['Nalla', 'Berozgaar'],
  ['Jhol', 'Ghotala'],
  ['Ullu', 'Gadha'],
  ['Lukkha', 'Awaara'],
  ['Senti', 'Drama'],
  ['Panga', 'Jhagda'],

  // ---- Desi everyday & college life ----
  ['Chai tapri', 'Dhaba'], ['Cutting chai', 'Masala chai'], ['Vada pav', 'Pav bhaji'], ['Pani puri', 'Bhel puri'],
  ['Lassi', 'Chaas'], ['Imarti', 'Jalebi'], ['Uttapam', 'Dosa'], ['Rajma chawal', 'Chole bhature'],
  ['Maggi', 'Cup noodles'], ['E-rickshaw', 'Auto rickshaw'], ['Hostel', 'PG'], ['Canteen', 'Mess'],
  ['Attendance', 'Proxy'], ['Viva', 'Practical'], ['Assignment', 'Journal'], ['Placement', 'Internship'],
  ['Holi', 'Diwali'], ['Garba', 'Dandiya'], ['Rangoli', 'Mehendi'], ['Ganpati', 'Navratri'],
  ['IPL', 'World Cup'], ['Dhoni', 'Kohli'], ['Shah Rukh', 'Salman'], ['Bollywood', 'Tollywood'],
  ['Jio', 'Airtel'], ['UPI', 'Cash'], ['Swiggy', 'Zomato'], ['Blinkit', 'Zepto'],
  ['Instagram', 'Snapchat'], ['Reels', 'Shorts'], ['WhatsApp', 'Telegram'], ['Netflix', 'Hotstar'],
  ['Ola', 'Uber'], ['Flipkart', 'Amazon'], ['Pressure cooker', 'Tiffin'], ['Chappal', 'Joota'],
];
