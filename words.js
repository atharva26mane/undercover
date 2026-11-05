'use strict';
// Word pairs for Undercover. Each pair = two similar-but-different things.
// One word goes to the Civilians, the other to the Undercover (randomly swapped each game).
// Pairs tagged 'meme' (memes + Hindi slang) are picked in about 8 out of 10 rounds.
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
  ['Jaldi the late', 'Home from work', 'meme'],        // Ravi Kishan's viral slips
  ['Ravi Kishan', 'Pankaj Tripathi', 'meme'],
  ['Binod', 'Bhupendra Jogi', 'meme'],                 // random names the internet made famous
  ['Moye Moye', 'Bado Badi', 'meme'],                  // viral meme songs
  ['Chin Tapak Dum Dum', 'Abra Ka Dabra', 'meme'],     // magic spells (Chhota Bheem villain meme)
  ['Mogambo', 'Gabbar', 'meme'],
  ['Jethalal', 'Babu Bhaiya', 'meme'],
  ['Kokilaben', 'Gopi Bahu', 'meme'],                  // "Rasode mein kaun tha"
  ['Munna Bhaiya', 'Kaleen Bhaiya', 'meme'],           // Mirzapur
  ['Sachiv ji', 'Pradhan ji', 'meme'],                 // Panchayat
  ['Panchayat', 'Gullak', 'meme'],
  ['Hera Pheri', 'Golmaal', 'meme'],
  ['Waah Shampy Waah', 'Malik galti ho gayi', 'meme'], // 2025 viral clips
  ['6-7', 'Skibidi', 'meme'],                          // Gen Alpha nonsense
  ['Vishal Mega Mart', 'D-Mart', 'meme'],              // + the "guard exam" meme
  ['Studio Ghibli', 'Nano Banana', 'meme'],            // AI photo trends
  ["India's Got Latent", 'Shark Tank India', 'meme'],
  ['Dhurandhar', 'Animal', 'meme'],
  ['Pushpa', 'Rocky Bhai', 'meme'],
  ['Shaktimaan', 'Chhota Bheem', 'meme'],
  ['Doraemon', 'Shinchan', 'meme'],
  ['CarryMinati', 'BB Ki Vines', 'meme'],
  ['Sigma', 'Alpha', 'meme'],
  ['Rizz', 'Aura', 'meme'],
  ['Delulu', 'Main character', 'meme'],
  ['Pookie', 'Babu Shona', 'meme'],

  // ---- Hindi / Hinglish slang ----
  ['Chapri', 'Tapori', 'meme'],
  ['Kalesh', 'Lafda', 'meme'],
  ['Bawaal', 'Bhasad', 'meme'],
  ['Jugaad', 'Setting', 'meme'],
  ['Jhakaas', 'Kadak', 'meme'],
  ['Bindaas', 'Mast', 'meme'],
  ['Faltu', 'Bakwaas', 'meme'],
  ['Bakaiti', 'Gappe', 'meme'],
  ['Ghanta', 'Thenga', 'meme'],
  ['Bhai', 'Yaar', 'meme'],
  ['Jalwa', 'Swag', 'meme'],
  ['Chillar', 'Note', 'meme'],
  ['Nalla', 'Berozgaar', 'meme'],
  ['Jhol', 'Ghotala', 'meme'],
  ['Ullu', 'Gadha', 'meme'],
  ['Lukkha', 'Awaara', 'meme'],
  ['Senti', 'Drama', 'meme'],
  ['Panga', 'Jhagda', 'meme'],


  // ---- More memes, filmy lines & desi pop culture ----
  ['Itna sannata kyun hai bhai', 'Kitne aadmi the', 'meme'],
  ['Uthale re baba', 'Ye Baburao ka style hai', 'meme'],
  ['Mere paas maa hai', 'Main jhukega nahi', 'meme'],
  ["How's the josh", 'Picture abhi baaki hai', 'meme'],
  ['Pawri ho rahi hai', 'Rasode mein kaun tha', 'meme'],
  ['Just looking like a wow', 'Mujhe farak nahi padta', 'meme'],
  ['Kuch toh gadbad hai', 'Daya darwaza tod do', 'meme'],
  ['Lock kiya jaye', 'Audience poll', 'meme'],
  ['Daya ben', 'Babita ji', 'meme'],
  ['Uday bhai', 'Majnu bhai', 'meme'],
  ['Chatur', 'Virus', 'meme'],
  ['Jeetu bhaiya', 'Sandeep bhaiya', 'meme'],
  ['Kota Factory', 'Aspirants', 'meme'],
  ['Gangs of Wasseypur', 'Mirzapur', 'meme'],
  ['3 Idiots', 'Chhichhore', 'meme'],
  ['Housefull', 'Dhamaal', 'meme'],
  ['Bhool Bhulaiyaa', 'Stree', 'meme'],
  ['Motu Patlu', 'Oggy', 'meme'],
  ['Nobita', 'Gian', 'meme'],
  ['Bigg Boss', 'Roadies', 'meme'],
  ['Sharma ji ka beta', 'Log kya kahenge', 'meme'],
  ['Padosi aunty', 'Rishtedaar', 'meme'],
  ['Samay Raina', 'Zakir Khan', 'meme'],
  ['Sakht launda', 'Simp', 'meme'],
  ['Abhinav Arora', 'Dolly Chaiwala', 'meme'],
  ['Orry', 'Uorfi Javed', 'meme'],
  ['Honey Singh', 'Badshah', 'meme'],
  ['Diljit Dosanjh', 'AP Dhillon', 'meme'],
  ['Coldplay tickets', 'Diljit concert', 'meme'],
  ['Rajpal Yadav', 'Johnny Lever', 'meme'],
  ['Bolo zubaan kesari', 'Daag achhe hain', 'meme'],
  ['Red flag', 'Green flag', 'meme'],
  ['Situationship', 'Talking stage', 'meme'],
  ['NPC', 'Side character', 'meme'],
  ['Ghosting', 'Seen zone', 'meme'],
  ['Brainrot', 'Doomscrolling', 'meme'],
  ['Gen Z', 'Millennial', 'meme'],

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
