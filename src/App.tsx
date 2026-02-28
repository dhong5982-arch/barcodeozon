/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { FileUp, FileText, Download, Loader2, AlertCircle } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

// Set up PDF.js worker using unpkg which is generally more reliable for specific versions
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

type OrderMapping = {
  shippingNumber: string;
  article: string;
  productName: string;
};

export default function App() {
  const [ordersFile, setOrdersFile] = useState<File | null>(null);
  const [labelsFile, setLabelsFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleProcess = async () => {
    if (!ordersFile || !labelsFile) {
      setError('Пожалуйста, загрузите оба файла.');
      return;
    }

    setIsProcessing(true);
    setError(null);
    setSuccess(null);

    try {
      // 1. Parse Orders PDF
      const ordersBuffer = await ordersFile.arrayBuffer();
      const mappings = await parseOrdersPdf(ordersBuffer);

      if (mappings.length === 0) {
        throw new Error('Не удалось найти данные о заказах в файле со списком.');
      }

      // 2. Process Labels PDF
      const labelsBuffer = await labelsFile.arrayBuffer();
      // Make a copy of the buffer because pdfjs or pdf-lib might detach it
      const labelsBufferCopy = labelsBuffer.slice(0);
      const modifiedPdfBytes = await processLabelsPdf(labelsBuffer, labelsBufferCopy, mappings);

      // 3. Download the result
      const blob = new Blob([modifiedPdfBytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `labels_with_articles_${new Date().getTime()}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setSuccess('Файл успешно обработан и скачан!');
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Произошла ошибка при обработке файлов.');
    } finally {
      setIsProcessing(false);
    }
  };

  const parseOrdersPdf = async (buffer: ArrayBuffer): Promise<OrderMapping[]> => {
    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
    const mappings: OrderMapping[] = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const items = textContent.items as any[];

      const fullText = items.map(item => item.str).join(' ');
      
      // Shipping number format: e.g., 0149711785-0110-1
      const shippingRegex = /(\d{8,12}-\d{4}-\d{1,2})/g;
      
      let match;
      const matches = [];
      while ((match = shippingRegex.exec(fullText)) !== null) {
        matches.push({ number: match[1], index: match.index });
      }

      for (let j = 0; j < matches.length; j++) {
        const currentMatch = matches[j];
        const nextMatch = matches[j + 1];
        
        const textBlock = fullText.substring(
          currentMatch.index + currentMatch.number.length,
          nextMatch ? nextMatch.index : fullText.length
        ).trim();

        let article = '';
        let productName = textBlock;

        // Try to match the pattern: ProductName Article Quantity LabelNumber [NextRowNumber]
        // Example: "... под покраску F/034 1 1785 2"
        const rowEndRegex = /(.*?)\s+(\S+)\s+(\d+)\s+(\d{4})\s*(?:\d+\s*)?$/;
        const rowEndMatch = textBlock.match(rowEndRegex);

        if (rowEndMatch) {
          productName = rowEndMatch[1].trim();
          article = rowEndMatch[2].trim();
        } else {
          // Fallback: look for typical article format (e.g., F/034)
          const articleRegex = /([A-Za-z0-9]+[-/][A-Za-z0-9]+)/;
          const articleMatch = textBlock.match(articleRegex);
          
          if (articleMatch) {
            article = articleMatch[1];
            productName = textBlock.substring(0, articleMatch.index).trim();
          }
        }

        // Clean up product name (remove leading numbers/spaces if any)
        productName = productName.replace(/^\s*\d+\s*/, '').trim();

        if (currentMatch.number) {
          mappings.push({
            shippingNumber: currentMatch.number,
            article: article,
            productName: productName
          });
        }
      }
    }

    return mappings;
  };

  const processLabelsPdf = async (bufferForPdfJs: ArrayBuffer, bufferForPdfLib: ArrayBuffer, mappings: OrderMapping[]): Promise<Uint8Array> => {
    // Read with pdfjs to find shipping numbers on each page
    const pdfjsDoc = await pdfjsLib.getDocument({ data: bufferForPdfJs }).promise;
    
    // Read with pdf-lib to modify
    const pdfDoc = await PDFDocument.load(bufferForPdfLib);
    pdfDoc.registerFontkit(fontkit);
    
    // Embed a font that supports Cyrillic
    const fontUrl = 'https://themes.googleusercontent.com/static/fonts/roboto/v9/W5F8_SL0XFawnjxHGsZjJA.ttf';
    const fontBytes = await fetch(fontUrl).then((res) => res.arrayBuffer());
    const customFont = await pdfDoc.embedFont(fontBytes);

    let modifiedCount = 0;

    for (let i = 0; i < pdfjsDoc.numPages; i++) {
      const page = await pdfjsDoc.getPage(i + 1);
      const textContent = await page.getTextContent();
      const fullText = textContent.items.map((item: any) => item.str).join(' ');

      // Find shipping number on this page
      const shippingRegex = /(\d{8,12}-\d{4}-\d{1,2})/;
      const match = fullText.match(shippingRegex);

      if (match) {
        const shippingNumber = match[1];
        const mapping = mappings.find(m => m.shippingNumber === shippingNumber);

        if (mapping) {
          modifiedCount++;
          const pdfPage = pdfDoc.getPage(i);
          const { width, height } = pdfPage.getSize();

          // Draw the article
          // We'll place it at the bottom of the label, centered
          const textToDraw = `Арт: ${mapping.article}`;
          
          const fontSize = 14;
          const textWidth = customFont.widthOfTextAtSize(textToDraw, fontSize);
          const textHeight = customFont.heightAtSize(fontSize);
          
          // Expand the page height to make room for the article
          const extraHeight = 25; // Space for the article and some padding
          pdfPage.setSize(width, height + extraHeight);
          
          // Shift all existing content up by extraHeight
          // In pdf-lib, we can't easily "shift" existing content, but we can change the media box
          // or just translate the coordinate system.
          // Actually, the easiest way to add space at the bottom in a PDF is to increase the height
          // and then draw our new text at the very bottom (y=0 to y=extraHeight).
          // Wait, PDF coordinates start at bottom-left (0,0).
          // If we just increase the height, the existing content stays at the bottom.
          // So we need to translate the existing content up.
          
          // Instead of translating, let's just draw it at the bottom. Since we increased the height,
          // the old content is still at y=0. Wait, if we increase height, the top expands.
          // To add space at the bottom, we need to shift the MediaBox.
          
          const { x, y, width: boxWidth, height: boxHeight } = pdfPage.getMediaBox();
          
          // Shift the bottom edge of the media box down (negative y)
          pdfPage.setMediaBox(x, y - extraHeight, boxWidth, boxHeight + extraHeight);
          
          // Now the new bottom is at y - extraHeight
          const newBottomY = y - extraHeight;
          
          // Calculate centered X position
          const xPos = (width - textWidth) / 2;
          
          // Position at the new bottom with a small margin
          const yPos = newBottomY + 5;
          
          // Draw a white background rectangle for readability
          pdfPage.drawRectangle({
            x: xPos - 5,
            y: yPos - 2,
            width: textWidth + 10,
            height: textHeight + 4,
            color: rgb(1, 1, 1),
          });

          // Draw the text
          pdfPage.drawText(textToDraw, {
            x: xPos,
            y: yPos,
            size: fontSize,
            font: customFont,
            color: rgb(0, 0, 0),
          });
        }
      }
    }

    if (modifiedCount === 0) {
      throw new Error('Не удалось найти совпадения номеров отправлений между файлами.');
    }

    return await pdfDoc.save();
  };

  return (
    <div className="min-h-screen bg-zinc-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-3xl mx-auto space-y-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900">
            Добавление артикулов на этикетки
          </h1>
          <p className="mt-4 text-lg text-zinc-600">
            Загрузите файл со списком заказов и файл с этикетками Ozon, чтобы автоматически добавить артикулы и названия товаров на этикетки.
          </p>
        </div>

        <div className="bg-white p-8 rounded-2xl shadow-sm border border-zinc-200 space-y-6">
          {/* File Uploads */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="block text-sm font-medium text-zinc-700">
                1. Файл со списком заказов (PDF)
              </label>
              <div className="mt-1 flex justify-center px-6 pt-5 pb-6 border-2 border-zinc-300 border-dashed rounded-xl hover:border-indigo-500 transition-colors bg-zinc-50">
                <div className="space-y-1 text-center">
                  <FileText className="mx-auto h-12 w-12 text-zinc-400" />
                  <div className="flex text-sm text-zinc-600 justify-center">
                    <label className="relative cursor-pointer rounded-md font-medium text-indigo-600 hover:text-indigo-500 focus-within:outline-none focus-within:ring-2 focus-within:ring-offset-2 focus-within:ring-indigo-500">
                      <span>Загрузить файл</span>
                      <input
                        type="file"
                        className="sr-only"
                        accept=".pdf"
                        onChange={(e) => setOrdersFile(e.target.files?.[0] || null)}
                      />
                    </label>
                  </div>
                  <p className="text-xs text-zinc-500">
                    {ordersFile ? ordersFile.name : 'PDF до 10MB'}
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-medium text-zinc-700">
                2. Файл с этикетками (PDF)
              </label>
              <div className="mt-1 flex justify-center px-6 pt-5 pb-6 border-2 border-zinc-300 border-dashed rounded-xl hover:border-indigo-500 transition-colors bg-zinc-50">
                <div className="space-y-1 text-center">
                  <FileUp className="mx-auto h-12 w-12 text-zinc-400" />
                  <div className="flex text-sm text-zinc-600 justify-center">
                    <label className="relative cursor-pointer rounded-md font-medium text-indigo-600 hover:text-indigo-500 focus-within:outline-none focus-within:ring-2 focus-within:ring-offset-2 focus-within:ring-indigo-500">
                      <span>Загрузить файл</span>
                      <input
                        type="file"
                        className="sr-only"
                        accept=".pdf"
                        onChange={(e) => setLabelsFile(e.target.files?.[0] || null)}
                      />
                    </label>
                  </div>
                  <p className="text-xs text-zinc-500">
                    {labelsFile ? labelsFile.name : 'PDF до 10MB'}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Status Messages */}
          {error && (
            <div className="rounded-xl bg-red-50 p-4 flex items-start">
              <AlertCircle className="h-5 w-5 text-red-400 mt-0.5 mr-3 flex-shrink-0" />
              <div className="text-sm text-red-700">{error}</div>
            </div>
          )}

          {success && (
            <div className="rounded-xl bg-emerald-50 p-4 flex items-start">
              <div className="text-sm text-emerald-700">{success}</div>
            </div>
          )}

          {/* Process Button */}
          <button
            onClick={handleProcess}
            disabled={!ordersFile || !labelsFile || isProcessing}
            className="w-full flex justify-center items-center py-3 px-4 border border-transparent rounded-xl shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isProcessing ? (
              <>
                <Loader2 className="animate-spin -ml-1 mr-2 h-5 w-5 text-white" />
                Обработка файлов...
              </>
            ) : (
              <>
                <Download className="-ml-1 mr-2 h-5 w-5" />
                Обработать и скачать
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

