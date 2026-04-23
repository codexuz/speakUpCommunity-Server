import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type SeedWritingTask = {
  taskText: string;
  part: string;
  minWords: number;
  maxWords: number;
  timeLimit: number;
  image?: string;
};

type SeedWritingTest = {
  title: string;
  description: string;
  tasks: SeedWritingTask[];
};

const CEFR_WRITING_TESTS: SeedWritingTest[] = [
  {
    title: 'Test 2',
    description:
      'Community park note/email tasks plus an online discussion response about technology.',
    tasks: [
      {
        part: 'Task 1',
        taskText:
          'You are a resident in a neighborhood where a new community park is being planned. You received a flyer from the local council:\n\n"Dear Resident,\nWe are excited to announce plans for a new community park in our neighborhood! This project aims to create a green space for recreation and community gathering. We are currently in the early planning stages and want to gather your feedback on the proposed features. We have included a brief overview of some initial ideas, but we are keen to hear your thoughts and suggestions.\nYour input is crucial in shaping this space for everyone to enjoy.\nSincerely,\nThe Local Council Planning Department"\n\nTask 1.1 (Note): Write a short note to your neighbor, who is also your friend. Write about your initial reaction to the news and what you hope to see in the park. Write about 50 words.',
        minWords: 45,
        maxWords: 100,
        timeLimit: 600,
      },
      {
        part: 'Task 1',
        taskText:
          'Task 1.2 (Email): Write an email to the Local Council Planning Department. Express your feelings about the park plans and provide specific suggestions for features or facilities you believe would benefit the community. Write 120-150 words.',
        minWords: 120,
        maxWords: 180,
        timeLimit: 1500,
      },
      {
        part: 'Task 2',
        taskText:
          'You are participating in an online discussion for language learners.\nThe question is: "Is technology making our lives better or worse?"\nPost your response, giving reasons and examples. Write 180-200 words.',
        minWords: 180,
        maxWords: 200,
        timeLimit: 2100,
      },
    ],
  },
  {
    title: 'Test 3',
    description:
      'Office onboarding welcome tasks plus an online discussion response about celebrity role models.',
    tasks: [
      {
        part: 'Task 1',
        taskText:
          'You are working in an office and your company wants to make new colleagues feel more welcome. Your company sent out this message:\n\n"Dear Employee,\nWe want to make our new colleagues feel very welcome when they start working here! We are planning a new way to help them settle in quickly and feel part of the team. We are at the beginning of this plan and want to hear your ideas. We have some initial thoughts below, but we really want to know what you think.\nYour ideas are important to help us make this a great welcome for everyone.\nSincerely,\nThe HR Department"\n\nTask 1.1 (Message): Write a short message to a colleague. Tell them about the plan to welcome new staff. Say what you think about it and what kind of welcome you hope new people will get. Write about 50 words.',
        minWords: 45,
        maxWords: 100,
        timeLimit: 600,
      },
      {
        part: 'Task 1',
        taskText:
          'Task 1.2 (Email): Write an email to the HR Department. Say you are happy about the plan to welcome new staff. Give some specific ideas for how to make new colleagues feel comfortable and quickly become part of the team. Write 120-150 words.',
        minWords: 120,
        maxWords: 180,
        timeLimit: 1500,
      },
      {
        part: 'Task 2',
        taskText:
          'You are participating in an online discussion for language learners.\nThe question is: "Are celebrities good role models for young people?"\nPost your response, giving reasons and examples. Write 180-200 words.',
        minWords: 180,
        maxWords: 200,
        timeLimit: 2100,
      },
    ],
  },
  {
    title: 'Test 4',
    description:
      'School environment improvement tasks plus an online discussion response about social media impacts on young users.',
    tasks: [
      {
        part: 'Task 1',
        taskText:
          "You are a teacher at a school, and the Head teacher wants to improve the school environment to make it a better place for both students and staff. The Head teacher has sent out a message seeking input:\n\n\"Dear Teaching Staff,\nWe are committed to making our school an even better place for everyone. To achieve this, we are looking for innovative ways to enhance our school setting - making it more supportive for students and more effective for us as educators. We believe your insights are invaluable as you are on the front lines every day. We have a few initial ideas, but we are eager to hear your thoughts and suggestions. Your professional experience and perspectives are crucial in shaping a more positive and productive school environment.\nSincerely,\nThe Head teacher\"\n\nTask 1.1 (Message): Write a short message to a colleague, who is your close friend. Tell them about the Head teacher's plan to improve the school environment. Say what you think about it and what kind of improvements you hope for. Write about 50 words.",
        minWords: 45,
        maxWords: 100,
        timeLimit: 600,
      },
      {
        part: 'Task 1',
        taskText:
          "Task 1.2 (Email): Write an email to the Head teacher. Express your support for the plan to improve the school environment. Provide specific suggestions for how the school setting could be made more supportive for students and more effective for teachers. Write about 120-150 words.",
        minWords: 120,
        maxWords: 180,
        timeLimit: 1500,
      },
      {
        part: 'Task 2',
        taskText:
          'You are participating in an online discussion for language learners.\nThe question is: "What do you think about the impacts of social media on young users?"\nPost your response, giving reasons and examples. Write 180-200 words.',
        minWords: 180,
        maxWords: 200,
        timeLimit: 2100,
      },
    ],
  },
  {
    title: 'Test 5',
    description:
      'Fitness club closure and improvement tasks plus an online discussion response about city vs town living.',
    tasks: [
      {
        part: 'Task 1',
        taskText:
          'You are a member of a fitness club. You received an email from the manager of the club:\n\n"Dear Member,\nI am sorry to inform you that the fitness center is closing for a month from next Monday. The building needs some repairs and we also plan to install some new equipment. What else do you think should be changed? As the center will not be operating for a month, what kind of alternative activities should we organize in the meantime? We appreciate your opinion very much.\nThe Manager."\n\nTask 1.1 (Letter): Write a letter to your friend, who is also a member of the club. Write about your feelings and what you think the club management should do about the situation. Write about 50 words.',
        minWords: 45,
        maxWords: 100,
        timeLimit: 600,
      },
      {
        part: 'Task 1',
        taskText:
          'Task 1.2 (Letter): Write a letter to the manager. Write about your feelings and what you think the club management should do about the situation. Write about 120-150 words.',
        minWords: 120,
        maxWords: 180,
        timeLimit: 1500,
      },
      {
        part: 'Task 2',
        taskText:
          'You are participating in an online discussion for language learners.\nThe question is: "Is it better to live in a big city or a small town?"\nPost your response, giving reasons and examples. Write 180-200 words.',
        minWords: 180,
        maxWords: 200,
        timeLimit: 2100,
      },
    ],
  },
  {
    title: 'Test 6',
    description:
      'Hotel complaint follow-up tasks plus an online discussion response about causes of air pollution.',
    tasks: [
      {
        part: 'Task 1',
        taskText:
          'You recently stayed at the Grandview Hotel for a short trip. Unfortunately, your experience was not great; your room was very noisy, and the air conditioning was not working properly. After you complained upon check-out, the hotel has now sent you an apology letter:\n\n"Dear Customer,\nWe truly regret that your experience fell short of our usual high standards. Please be assured that we are addressing these issues immediately to prevent similar occurrences for future guests.\nAs a gesture of our sincere apology, we would like to offer you a complimentary one-night stay in a newly renovated deluxe room, valid for six months, to provide you with the exceptional experience we strive for.\nWe value your feedback and hope you will give us another opportunity to demonstrate our commitment to guest satisfaction.\nSincerely,\nGrandview Hotel Manager"\n\nTask 1.1 (Message): Write a short message to a friend, who knows about your recent trip. Tell them about the apology letter you received from the Grandview Hotel. Say what you think about their apology and the offer. Write about 50 words.',
        minWords: 45,
        maxWords: 100,
        timeLimit: 600,
      },
      {
        part: 'Task 1',
        taskText:
          'Task 1.2 (Email): Write an email to the Hotel Manager. Express your appreciation for the apology and the offer. Explain if you plan to accept their offer, or if you have an alternative suggestion for a resolution. Write about 120-150 words.',
        minWords: 120,
        maxWords: 180,
        timeLimit: 1500,
      },
      {
        part: 'Task 2',
        taskText:
          'You are participating in an online discussion for language learners.\nThe question is: "What are the reasons for air pollution?"\nPost your response, giving reasons and examples. Write 180-200 words.',
        minWords: 180,
        maxWords: 200,
        timeLimit: 2100,
      },
    ],
  },
  {
    title: 'Test 7',
    description:
      'HR work-from-home policy feedback tasks plus an online discussion response about rising teenage crime.',
    tasks: [
      {
        part: 'Task 1',
        taskText:
          'You work in a company, and you received a letter from the HR manager:\n\n"Dear Worker,\nI want to inform you that we have decided to allow some workers work from their homes. What do you think about this plan? Can this plan bring any benefits for workers and the company? We appreciate your opinion very much.\nThe HR Manager."\n\nTask 1.1 (Letter): Write a letter to your friend. Write about your feelings about this method and what you think they should also allow you to work from home or not. Write about 50 words.',
        minWords: 45,
        maxWords: 100,
        timeLimit: 600,
      },
      {
        part: 'Task 1',
        taskText:
          'Task 1.2 (Letter): Write a letter to the manager. Write about your feelings about this method and whether you think they should also allow you to work from home or not. Write about 120-150 words.',
        minWords: 120,
        maxWords: 180,
        timeLimit: 1500,
      },
      {
        part: 'Task 2',
        taskText:
          'You are participating in an online discussion for language learners.\nThe question is: "Why is the crime rate increasing among teenagers?"\nPost your response, giving reasons and examples. Write 180-200 words.',
        minWords: 180,
        maxWords: 200,
        timeLimit: 2100,
      },
    ],
  },
  {
    title: 'Test 8',
    description:
      'Neighbor noise complaint response tasks plus an online discussion response about smartphone use in schools.',
    tasks: [
      {
        part: 'Task 1',
        taskText:
          'You live in a high-rising building, and you received a complaint letter from your neighbor:\n\n"Dear Neighbor,\nI am sorry to inform you that your disturbance made some inconveniences for me and my family last night. You should consider other neighbors when you hold any gatherings in your flat. I hope that you will not cause loud noise anymore. I really appreciate your future actions to prevent from such noise.\nWarm regards,\nMr. Edward"\n\nTask 1.1 (Letter): Write a letter to your friend, who is also your neighbor. Write about your feelings about this complaint letter and what plans you have to prevent such inconveniences. Write about 50 words.',
        minWords: 45,
        maxWords: 100,
        timeLimit: 600,
      },
      {
        part: 'Task 1',
        taskText:
          'Task 1.2 (Letter): Write a letter to your neighbor. Write about your feelings about this complaint letter and what plans you have to prevent such inconveniences. Write about 120-150 words.',
        minWords: 120,
        maxWords: 180,
        timeLimit: 1500,
      },
      {
        part: 'Task 2',
        taskText:
          'You are participating in an online discussion for language learners.\nThe question is: "Should students not be allowed to use smartphones at schools?"\nPost your response, giving reasons and examples. Write 180-200 words.',
        minWords: 180,
        maxWords: 200,
        timeLimit: 2100,
      },
    ],
  },
  {
    title: 'Test 9',
    description:
      'Library job-offer response tasks plus an online discussion response about when children should start learning foreign languages.',
    tasks: [
      {
        part: 'Task 1',
        taskText:
          'You live near the local library and are unemployed. You received an email from the library manager offering you a job:\n\n"Dear Alex,\nAs we have expanded the library, we are looking for a hard worker for our team. We have been told that you are unemployed currently, and you have some experience working in a library so we are contacting you. What do you think about working in our library?\nWe appreciate your opinion very much.\nThe Manager."\n\nTask 1.1 (Letter): Write a letter to your friend. Tell them about this job offer. Write about your feelings and whether you accept this offer or not. Write about 50 words.',
        minWords: 45,
        maxWords: 100,
        timeLimit: 600,
      },
      {
        part: 'Task 1',
        taskText:
          'Task 1.2 (Letter): Write a letter to the manager. Write about your feelings and whether you accept this offer or not. Write about 120-150 words.',
        minWords: 120,
        maxWords: 180,
        timeLimit: 1500,
      },
      {
        part: 'Task 2',
        taskText:
          'You are participating in an online discussion for language learners.\nThe question is: "Should children learn a foreign language from the time they start school or is it better to wait until a child is at secondary school?"\nPost your response, giving reasons and examples. Write 180-200 words.',
        minWords: 180,
        maxWords: 200,
        timeLimit: 2100,
      },
    ],
  },
  {
    title: 'Test 10',
    description:
      'Internet service complaint response tasks plus an online discussion response about practical life skills vs traditional school subjects.',
    tasks: [
      {
        part: 'Task 1',
        taskText:
          'You are a usual customer of an internet company. You received an email from the manager of the company:\n\n"We have heard that people in your area are having problems with their internet connection. We are truly sorry for that. We are going to fix them soon. And what improvements do you think should be done? We appreciate your opinion very much.\nThe Manager."\n\nTask 1.1 (Letter): Write a letter to your friend, who is also a user of the internet company. Tell them about the email you received. Write about your feelings and what you think the company should do about the situation. Write about 50 words.',
        minWords: 45,
        maxWords: 100,
        timeLimit: 600,
      },
      {
        part: 'Task 1',
        taskText:
          'Task 1.2 (Letter): Write a letter to the manager. Write about your feelings and what you think the company should do about the situation. Write about 120-150 words.',
        minWords: 120,
        maxWords: 180,
        timeLimit: 1500,
      },
      {
        part: 'Task 2',
        taskText:
          'You are participating in an online discussion for language learners.\nThe question is: "Should schools teach how to manage money and cooking, or are traditional subjects like math and science more important?"\nPost your response, giving reasons and examples. Write 180-200 words.',
        minWords: 180,
        maxWords: 200,
        timeLimit: 2100,
      },
    ],
  },
  {
    title: 'Test 11',
    description:
      'Cinema club schedule/content change feedback tasks plus an online discussion response about urban road safety.',
    tasks: [
      {
        part: 'Task 1',
        taskText:
          'You received a message from your cinema club manager. The cinema club management is considering moving weekly movie time from Friday evenings to Tuesday mornings to reduce theater rental costs. They are also planning to stop showing international movies with subtitles and instead focus only on high-budget Hollywood films.\n\nTask 1.1 (Letter): Write a short letter to your friend who also attends this cinema club with you. Explain the situation about the possible changes and tell them how you feel about it. Write about 50 words.',
        minWords: 45,
        maxWords: 100,
        timeLimit: 600,
      },
      {
        part: 'Task 1',
        taskText:
          'Task 1.2 (Letter): Write a letter to the cinema club manager. Give your opinion about moving the movie time to Tuesday mornings, explain what you think about focusing only on Hollywood movies, and suggest what the club should do instead. Write about 120-150 words.',
        minWords: 120,
        maxWords: 180,
        timeLimit: 1500,
      },
      {
        part: 'Task 2',
        taskText:
          'You are participating in an online language discussion.\nThe question is: "Road safety in urban areas." Write why road safety is important and give problems that people face on roads.\nPost your response, giving reasons and examples. Write 180-200 words.',
        minWords: 180,
        maxWords: 200,
        timeLimit: 2100,
      },
    ],
  },
  {
    title: 'Test 12',
    description:
      'Book club member absence communication tasks plus an online discussion response about fast food as a daily habit.',
    tasks: [
      {
        part: 'Task 1',
        taskText:
          'You are a member of a book club. The organizer sent you this message:\n\n"Dear Member, One of our members, James Hollewon, will not be able to attend the next meeting. We would like your suggestions. How should we inform other members about this change? What alternative activities could we plan for the meeting? How can we make the meeting still interesting without him? Best wishes, The Book Club Organizer"\n\nTask 1.1 (Email): Write a short email to your friend who is also a member of the book club. Tell them about the situation and ask what ideas they have for the meeting. Write about 50 words.',
        minWords: 45,
        maxWords: 100,
        timeLimit: 600,
      },
      {
        part: 'Task 1',
        taskText:
          'Task 1.2 (Email): Write an email to the book club organizer. Give your suggestions about informing members, planning activities, and keeping the meeting interesting. Write 120–150 words.',
        minWords: 120,
        maxWords: 180,
        timeLimit: 1500,
      },
      {
        part: 'Task 2',
        taskText:
          'You are participating in an online discussion for students.\nThe question is: "Fast food has become a normal part of everyday life. Is this a positive or negative development?" Give your opinion with reasons and examples. Write 180–200 words.',
        minWords: 180,
        maxWords: 200,
        timeLimit: 2100,
      },
    ],
  },
];

async function main() {
  console.log('Starting CEFR writing seeding...');

  for (const seedTest of CEFR_WRITING_TESTS) {
    const existing = await prisma.writingTest.findFirst({
      where: {
        title: seedTest.title,
        examType: 'cefr',
      },
      select: { id: true },
    });

    if (existing) {
      console.log(`Skipping existing test: ${seedTest.title}`);
      continue;
    }

    const createdTest = await prisma.writingTest.create({
      data: {
        title: seedTest.title,
        description: seedTest.description,
        examType: 'cefr',
        isPublished: true,
      },
    });

    await prisma.writingTask.createMany({
      data: seedTest.tasks.map((task) => ({
        testId: createdTest.id,
        taskText: task.taskText,
        part: task.part,
        minWords: task.minWords,
        maxWords: task.maxWords,
        timeLimit: task.timeLimit,
        image: task.image,
      })),
    });

    console.log(`Created ${seedTest.title} with ${seedTest.tasks.length} tasks.`);
  }

  console.log('CEFR writing seeding completed successfully!');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });


