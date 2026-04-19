import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';

const prisma = new PrismaClient();

async function main() {
  console.log('Starting CEFR seeding...');

  // 1. Load data
  const dataPath = path.join(__dirname, '../cefr-questions.json');
  const rawData = fs.readFileSync(dataPath, 'utf8');
  const allQuestions = JSON.parse(rawData);

  // 2. Group by test title
  const testsMap: Record<string, any[]> = {};

  allQuestions.forEach((q: any) => {
    const testTitle = q.test || 'General CEFR Test';
    if (!testsMap[testTitle]) {
      testsMap[testTitle] = [];
    }
    testsMap[testTitle].push(q);
  });

  const testTitles = Object.keys(testsMap);
  console.log(`Found ${testTitles.length} CEFR tests to create.`);

  // 3. Create Tests and Questions
  for (const title of testTitles) {
    const questions = testsMap[title];

    // Create Test
    const test = await prisma.test.create({
      data: {
        title: title,
        description: `CEFR Speaking Practice Test - ${title}`,
        testType: 'cefr',
        isPublished: true,
      },
    });

    for (const q of questions) {
      const qText = q.q_text;
      const partNum = q.part;
      
      let speakingTimer = 60;
      let prepTimer = 5;

      // Timer Logic
      if (qText.trim().toLowerCase().startsWith('describe')) {
        speakingTimer = 45;
        prepTimer = 10;
      } else {
        if (partNum === 1) {
          speakingTimer = 60;
          prepTimer = 5;
        } else if (partNum === 2) {
          speakingTimer = 120;
          prepTimer = 60;
        } else if (partNum === 3) {
          speakingTimer = 120;
          prepTimer = 60;
        }
      }

      await prisma.question.create({
        data: {
          testId: test.id,
          qText: qText,
          part: `Part ${partNum}`,
          speakingTimer: speakingTimer,
          prepTimer: prepTimer,
        },
      });
    }

    console.log(`Created ${title} with ${questions.length} questions.`);
  }

  console.log('CEFR Seeding completed successfully!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
