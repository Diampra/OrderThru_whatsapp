/**
 * FOOD_KEYWORDS: 150+ common food/drink items across cuisines.
 * Used to extract the food noun from conversational text.
 * e.g. "biryani hai kya" → matches "biryani" → clean search term
 * 
 * Multi-word items MUST come before single-word to get longest match first.
 */
export const FOOD_KEYWORDS: string[] = [
  // Indian mains (multi-word first)
  'chicken biryani', 'mutton biryani', 'veg biryani', 'hyderabadi biryani',
  'paneer tikka masala', 'palak paneer', 'shahi paneer', 'paneer butter masala',
  'dal makhani', 'dal tadka', 'dal fry',
  'butter chicken', 'chicken curry', 'chicken masala', 'chicken tikka',
  'mutton curry', 'mutton rogan josh', 'mutton keema',
  'chhole bhature', 'rajma chawal', 'kadai paneer',
  'aloo gobi', 'aloo matar', 'aloo jeera', 'aloo paratha',
  'matar paneer', 'mix veg',
  'fish curry', 'fish fry',
  'prawn curry', 'prawn masala',
  'egg curry', 'egg bhurji', 'egg fried rice',
  'jeera rice', 'dum aloo',
  // Indian single
  'biryani', 'pulao', 'khichdi', 'haleem',
  'paneer', 'tikka', 'korma',
  'chapati', 'roti', 'naan', 'kulcha', 'paratha', 'bhatura',
  'idli', 'dosa', 'uttapam', 'vada', 'sambhar', 'rasam',
  'puri', 'poha', 'upma', 'dhokla',
  'samosa', 'kachori', 'pakora', 'bhajia',
  'chaat', 'pani puri', 'gol gappa', 'bhel puri', 'sev puri', 'dahi puri',
  'pav bhaji', 'misal pav', 'dabeli',
  'lassi', 'chaas', 'buttermilk',
  'raita', 'pickle', 'papad',
  'kheer', 'halwa', 'gulab jamun', 'jalebi', 'barfi', 'ladoo', 'rasgulla',
  // Bakery
  'bread', 'croissant', 'muffin', 'scone', 'baguette', 'bun', 'roll',
  'cake', 'cupcake', 'brownie', 'pastry', 'donut', 'doughnut',
  'cookie', 'biscuit', 'wafer',
  'tart', 'pie', 'cheesecake', 'pudding', 'mousse',
  'macaroon', 'eclair', 'profiterole',
  // Fast food & continental
  'pizza', 'pasta', 'burger', 'sandwich', 'wrap', 'hotdog', 'sub',
  'frankies', 'frankie', 'roll', 'kathi roll',
  'fried rice', 'noodles', 'chowmein', 'hakka noodles', 'lo mein',
  'manchurian', 'spring roll', 'momos', 'dim sum',
  'steak', 'grilled chicken', 'bbq chicken', 'wings',
  'tacos', 'nachos', 'quesadilla', 'burrito',
  'sushi', 'ramen', 'udon',
  'falafel', 'shawarma', 'kebab', 'shish kebab',
  'fish and chips', 'fish chips',
  // Snacks
  'fries', 'chips', 'wedges', 'nuggets', 'popcorn',
  'garlic bread', 'bruschetta',
  'soup', 'tomato soup', 'corn soup', 'mushroom soup',
  'salad', 'caesar salad', 'greek salad',
  // Beverages
  'coffee', 'cappuccino', 'latte', 'espresso', 'americano', 'mocha',
  'cold coffee', 'iced coffee', 'cold brew',
  'tea', 'chai', 'green tea', 'masala chai', 'ginger tea',
  'juice', 'orange juice', 'lemon juice', 'lime juice',
  'smoothie', 'milkshake', 'shake',
  'water', 'soda', 'cola', 'pepsi', 'mojito', 'lemonade',
  'hot chocolate', 'cocoa',
  // Desserts / Ice cream
  'ice cream', 'gelato', 'sorbet',
  'chocolate', 'vanilla', 'strawberry',
  'waffles', 'pancakes',
];

/**
 * Hindi filler phrases and question words to strip before searching.
 */
export const HINDI_FILLERS = [
  'hai kya', 'hai kya?', 'milega kya', 'milega', 'chahiye', 'dena',
  'do mujhe', 'mujhe', 'dijiye', 'please', 'yaar', 'bhai',
  'ek', 'do', 'teen', 'char', 'paanch',
  'kya', 'kya hai', 'kyaa', 'hain', 'hai', 'aata hai', 'ata hai',
  'available hai', 'available', 'order karna hai', 'order karo', 'order',
  'i want', 'give me', 'get me', 'can i have', 'i need',
  'some', 'add', 'want',
];

/**
 * Extracts the clean food item name from conversational text.
 * Priority:
 * 1. Match against FOOD_KEYWORDS list (longest match wins)
 * 2. Strip Hindi/English filler words
 * 3. Fall back to cleaned text
 */
export function extractFoodName(text: string): string {
  const lower = text.toLowerCase().trim();

  // 1. Try to match longest food keyword first
  const sortedKeywords = [...FOOD_KEYWORDS].sort((a, b) => b.length - a.length);
  for (const keyword of sortedKeywords) {
    if (lower.includes(keyword)) {
      return keyword;
    }
  }

  // 2. Strip Hindi/English fillers and return cleaned text
  const sortedFillers = [...HINDI_FILLERS].sort((a, b) => b.length - a.length);
  let cleaned = lower;
  for (const filler of sortedFillers) {
    cleaned = cleaned.replace(new RegExp(`\\b${filler}\\b`, 'gi'), '');
  }
  // Also strip punctuation and extra spaces
  cleaned = cleaned.replace(/[?!,\.]/g, '').replace(/\s+/g, ' ').trim();

  return cleaned || lower;
}
