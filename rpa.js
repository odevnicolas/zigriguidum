const puppeteer = require('puppeteer');
const { Client } = require('pg');

const dbConfig = {
  connectionString: 'postgresql://zerooitocincoadm:GrzYTKeT3ZmSg4JfpnVqUYSd@zerooitocincodb.c5qnvtxpcnuu.us-east-1.rds.amazonaws.com:5432/085db?schema=public',
  ssl: {
    rejectUnauthorized: false
  }
};

function formatDate(dateStr) {
  const [year, month, day] = dateStr.split('-');
  return `${day}/${month}/${year}`;
}

async function fetchDataAndStoreInDB() {
  console.log('Iniciando o navegador...');
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();
  
  console.log('Conectando ao banco de dados...');
  const client = new Client(dbConfig);
  await client.connect();

  try {
    console.log('Buscando dados do banco de dados...');
    const people = await client.query('SELECT id, name, TO_CHAR(birth_date, \'YYYY-MM-DD\') as birth_date, mother_name FROM public."People" WHERE city_id = $1 AND name IS NOT NULL AND birth_date IS NOT NULL AND mother_name IS NOT NULL AND (preenchidorpa = false OR preenchidorpa IS NULL)', [1023]);

    const totalPeople = people.rowCount;
    let processedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let notFoundCount = 0;

    console.log(`Encontradas ${totalPeople} pessoas para processar.`);

    for (const person of people.rows) {
      console.log(`\nProcessando pessoa ${processedCount + skippedCount + failedCount + 1} de ${totalPeople} com nome: ${person.name}`);

      await page.goto('https://www.tre-ce.jus.br/servicos-eleitorais/titulo-e-local-de-votacao/consulta-por-nome', { waitUntil: 'networkidle2' });
      
      if (await page.$('button[title="Ciente"]') !== null) {
        await page.click('button[title="Ciente"]');
        console.log('Pop-up de cookies fechado.');
      }

      const formattedBirthDate = formatDate(person.birth_date);

      if (await page.$('#LV_NomeTituloCPF') !== null) {
        await page.type('#LV_NomeTituloCPF', person.name);
        console.log(`Nome preenchido: ${person.name}`);
      } else {
        skippedCount++;
        console.log(`Pessoas processadas: ${processedCount}, Pessoas puladas: ${skippedCount}, Falhas ao processar: ${failedCount}, Pessoas não encontradas: ${notFoundCount}, Restantes: ${totalPeople - (processedCount + skippedCount + failedCount)}`);
        continue; 
      }
      
      if (await page.$('#LV_DataNascimento') !== null) {
        await page.type('#LV_DataNascimento', formattedBirthDate);
        console.log(`Data de nascimento preenchida: ${formattedBirthDate}`);
      } else {
        skippedCount++;
        console.log(`Pessoas processadas: ${processedCount}, Pessoas puladas: ${skippedCount}, Falhas ao processar: ${failedCount}, Pessoas não encontradas: ${notFoundCount}, Restantes: ${totalPeople - (processedCount + skippedCount + failedCount)}`);
        continue; 
      }
      
      if (await page.$('#LV_NomeMae') !== null) {
        await page.type('#LV_NomeMae', person.mother_name);
        console.log(`Nome da mãe preenchido: ${person.mother_name}`);
      } else {
        skippedCount++;
        console.log(`Pessoas processadas: ${processedCount}, Pessoas puladas: ${skippedCount}, Falhas ao processar: ${failedCount}, Pessoas não encontradas: ${notFoundCount}, Restantes: ${totalPeople - (processedCount + skippedCount + failedCount)}`);
        continue; 
      }

      try {
        await page.waitForSelector('#consultar-local-votacao-form-submit', { visible: true, timeout: 90000 }); 
        const button = await page.$('#consultar-local-votacao-form-submit');
        await page.evaluate(b => b.click(), button);
  
        console.log(`Submetendo formulário para nome: ${person.name}`);
        
        await page.waitForFunction(() => !document.body.innerText.includes('carregando conteúdo'), { timeout: 90000 });

        if (await page.$('div.alert.alert-warning') !== null) {
          console.log(`Pessoas não encontradas no sistema do TRE: ${person.name}`);
          await page.screenshot({ path: `pessoa_nao_encontrada_${person.name}.png` });
          notFoundCount++;
          console.log(`Pessoas processadas: ${processedCount}, Pessoas puladas: ${skippedCount}, Falhas ao processar: ${failedCount}, Pessoas não encontradas: ${notFoundCount}, Restantes: ${totalPeople - (processedCount + skippedCount + failedCount + notFoundCount)}`);
          continue;
        }

        const data = await page.evaluate(() => {
          const getText = (selector) => {
            const element = Array.from(document.querySelectorAll('p')).find(el => el.textContent.includes(selector));
            return element ? element.textContent.split(': ')[1].trim() : null;
          };

          return {
            zona: getText('Zona:'),
            secao: getText('Seção:'),
            local: getText('Local:'),
            endereco: getText('Endereço:'),
            municipio: getText('Município:'),
            biometria: document.body.innerText.includes("ELEITOR/ELEITORA COM BIOMETRIA COLETADA")
          };
        });

        if (data) {
          console.log(`Dados encontrados para nome: ${person.name}: ${JSON.stringify(data)}`);
          if (!data.zona || !data.secao || !data.local || !data.endereco || !data.municipio) {
            await console.log(`Dados nulos encontrados para ${person.name}. Pulando atualização.`);
            failedCount++;
          } else {
            console.log(`Atualizando banco de dados para ${person.name}...`);
            await client.query(
              'UPDATE public."People" SET zona_eleitoral = $1, secao_eleitoral = $2, local_votacao = $3, endereco_votacao = $4, municipio_votacao = $5, biometria = $6, preenchidorpa = true WHERE id = $7',
              [parseInt(data.zona, 10), parseInt(data.secao, 10), data.local, data.endereco, data.municipio, data.biometria, person.id]
            );
            processedCount++;
          }
        } else {
          console.log(`Nenhum dado encontrado para nome: ${person.name}`);
          await page.screenshot({ path: `dados_nulos_${person.name}.png` });
          failedCount++;
        }
      } catch (formError) {
        failedCount++;
      }

      console.log(`Pessoas processadas: ${processedCount}, Pessoas puladas: ${skippedCount}, Falhas ao processar: ${failedCount}, Pessoas não encontradas: ${notFoundCount}, Restantes: ${totalPeople - (processedCount + skippedCount + failedCount + notFoundCount)}`);
    }
  } catch (error) {
    await page.screenshot({ path: 'error_screenshot.png' }); 
  } finally {
    await client.end();
    await browser.close();
  }
}

fetchDataAndStoreInDB().catch(console.error);
